// --- "Your MDBList/Trakt Lists" ----------------------------------------------
//
// Once a key (and, for Trakt, a username) is entered above, shows every
// list that account actually owns -- not just the one built-in watchlist
// shortcut above. Debounced (fires a bit after typing stops, not on every
// keystroke) since it's a real network call.
let myMdblistListsTimer = null;
function scheduleMyMdblistListsRefresh() {
  clearTimeout(myMdblistListsTimer);
  myMdblistListsTimer = setTimeout(runMyMdblistLists, 600);
}

let myTraktListsTimer = null;
function scheduleMyTraktListsRefresh() {
  clearTimeout(myTraktListsTimer);
  myTraktListsTimer = setTimeout(runMyTraktLists, 600);
}

async function runMyMdblistLists() {
  const box = document.getElementById('myMdblistListsResult');
  if (!box) return;
  const isDisc = localStorage.getItem('myListAddon:mdblistDisconnected') === 'true';
  const keyInput = document.getElementById('mdblistKeyInput');
  const manualKey = keyInput ? keyInput.value.trim() : '';
  const token = isDisc ? '' : (mdblistAccessToken || readProviderSecret('myListAddon:mdblistAccessToken') || '');
  const key = isDisc ? '' : (manualKey || token || readProviderSecret('myListAddon:mdblistKey') || '');
  if (!key) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>Connect your MDBList account in Settings or click <strong>Connect MDBList</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';
    return;
  }
  box.innerHTML = '<p class="u-mt-10px"><small>Loading your MDBList lists\u2026</small></p>';
  try {
    // POST: an MDBList key or token is never put in a URL (the server refuses it).
    const res = await fetch(ORIGIN + '/api/mdblist-my-lists', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token ? { accessToken: token } : { apikey: manualKey || key }),
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your MDBList lists.') + '</p>';
      return;
    }
    if (data.username) {
      mdblistUsername = data.username;
      try {
        localStorage.setItem('myListAddon:mdblistUsername', mdblistUsername);
        localStorage.removeItem('myListAddon:mdblistDisconnected');
      } catch (e) {}
      renderMdblistConnectStatus();
      if (typeof pushCreatorSync === 'function') pushCreatorSync();
    }
    renderMyMdblistLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your MDBList lists.</p>';
  }
}

let _mdblistAiringNextEnriching = false;
let _mdblistAiringNextEnrichedAt = 0;
async function enrichMdblistAiringNextDates(list) {
  if (!list || !Array.isArray(list.items) || !list.items.length) return;
  const hasExpired = (list.items || []).some((it) => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
  if (!hasExpired && _mdblistAiringNextEnrichedAt && (Date.now() - _mdblistAiringNextEnrichedAt < 300000)) return;
  _mdblistAiringNextEnriching = true;

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || readProviderSecret('myListAddon:tmdbKey') || '';

  try {
    const rawCandidates = (window._mdblistRawAiringCandidates && window._mdblistRawAiringCandidates.length)
      ? window._mdblistRawAiringCandidates
      : (list.items || []);
    const candidates = rawCandidates.slice(0, 80);
    const enriched = [];
    const concurrency = 5;
    for (let i = 0; i < candidates.length; i += concurrency) {
      const chunk = candidates.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (it) => {
        try {
          const showId = it.imdbId || (it.id && String(it.id).startsWith('tt') ? it.id : '') || (it.tmdbId ? 'tmdb:' + it.tmdbId : (it.id ? (String(it.id).startsWith('tmdb:') ? it.id : 'tmdb:' + it.id) : ''));
          if (!showId) return;
          const bypass = hasExpired ? '&fresh=1&_t=' + Date.now() : '';
          const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(showId) + '&type=series&tmdbKey=' + encodeURIComponent(tmdbKey) + bypass);
          const data = await res.json();
          const d = data && data.ok ? data.details : null;
          if (d && d.nextEpisodeAirDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(d.nextEpisodeAirDate))) {
            it.airDate = d.nextEpisodeAirDate;
            it.seasonNum = d.nextEpisodeSeasonNumber;
            it.episodeNum = d.nextEpisodeNumber;
            it.isSeasonPremiere = (typeof d.isSeasonPremiere === 'boolean') ? d.isSeasonPremiere : (d.nextEpisodeNumber === 1);
            it.isSeasonFinale = !!d.isSeasonFinale;
            it.seasonFinaleAirDate = d.seasonFinaleAirDate || null;
            it.seasonFinaleEpisodeNumber = d.seasonFinaleEpisodeNumber || null;
            it.isUnaired = true;
            it.episodeTitle = d.nextEpisodeName || (it.isSeasonPremiere ? 'Season Premiere' : (it.isSeasonFinale ? 'Season Finale' : ('Episode ' + d.nextEpisodeNumber)));
            enriched.push(it);
          }
        } catch (e) {}
      }));
    }
    if (enriched.length) {
      enriched.sort((a, b) => (a.airDate || '').localeCompare(b.airDate || ''));
      list.items = enriched;
      list.itemCount = enriched.length;
      try {
        localStorage.setItem('myListAddon:mdblistAiringNextCache', JSON.stringify(enriched));
      } catch (e) {}
      _mdblistAiringNextEnrichedAt = Date.now();
      renderMyMdblistLists(window._myMdblistLists);
    }
  } finally {
    _mdblistAiringNextEnriching = false;
  }
}

function resolveListCardItemPoster(it) {
  if (!it) return '';
  let p = it.poster || it.showPoster || '';
  if (typeof p === 'string' && p.startsWith('/')) {
    p = 'https://image.tmdb.org/t/p/w500' + p;
  }
  if (!p) {
    const epId = String(it.id || '');
    const sId = it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (it.imdbId || (typeof it.id === 'string' && it.id.startsWith('tt') ? it.id : '')));
    if (sId && String(sId).startsWith('tt')) {
      p = 'https://images.metahub.space/poster/medium/' + sId + '/img';
    }
  }
  if (typeof resolveClientPoster === 'function') {
    return resolveClientPoster(it, p || '');
  }
  return p || '';
}

function openMdblistUpNextDetailsPage() {
  const list = (window._myMdblistLists || []).find((l) => l && (l.statusKey === 'upnext' || l.slug === 'upnext' || (l.url && (l.url === 'mdblist:user:shows:upnext' || l.url === 'mdblist:upnext' || l.url.includes(':upnext')))));
  if (!list) return;
  const sample = (list.items || []).map((it) => {
    const sNum = it.seasonNum;
    const eNum = it.episodeNum;
    const epSubtitle = it.episodeTitle || (sNum != null && eNum != null ? ('S' + sNum + 'E' + eNum) : '');
    const airingMatch = typeof findAiringMatchFor === 'function' ? findAiringMatchFor(it) : null;
    const isPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (airingMatch ? airingMatch.isSeasonPremiere : (eNum === 1));
    const isFinale = !!(it.isSeasonFinale || (airingMatch && airingMatch.isSeasonFinale));
    const finaleAirDate = it.seasonFinaleAirDate || (airingMatch ? (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : null)) : null);
    const finaleEpNum = it.seasonFinaleEpisodeNumber || (airingMatch ? airingMatch.seasonFinaleEpisodeNumber : null);
    const effectiveAirDate = it.airDate || (airingMatch ? airingMatch.airDate : '');
    return {
      id: it.id,
      type: 'series',
      name: it.title || it.name || 'Untitled',
      subtitle: epSubtitle,
      poster: resolveListCardItemPoster(it),
      showId: it.showId || it.id,
      seasonNum: sNum,
      episodeNum: eNum,
      airDate: effectiveAirDate,
      airTime: it.airTime || (airingMatch ? airingMatch.airTime : ''),
      isUnaired: effectiveAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(effectiveAirDate) : !!(it.isUnaired || (airingMatch && airingMatch.isUnaired)),
      isSeasonPremiere: isPremiere,
      isSeasonFinale: isFinale,
      seasonFinaleAirDate: finaleAirDate,
      seasonFinaleEpisodeNumber: finaleEpNum,
      removeExternalProvider: 'mdblist',
      removeExternalTarget: 'watchlist',
      removeExternalListId: 'watchlist',
    };
  });
  openListDetailsPage('MDBList Up Next', 'series', 'mdblist:user:shows:upnext', { sample: sample, count: sample.length, maybeMore: false });
}

function openMdblistAiringNextDetailsPage() {
  const list = (window._myMdblistLists || []).find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
  if (!list) return;
  const filtered = (list.items || []).filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
  const localAiringList = (typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
  const sample = filtered.map((it) => {
    const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
    const isPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (localMatch ? localMatch.isSeasonPremiere : (it.episodeNum === 1));
    const isFinale = !!(it.isSeasonFinale || (localMatch && localMatch.isSeasonFinale));
    const finaleAirDate = it.seasonFinaleAirDate || (localMatch && localMatch.seasonFinaleAirDate) || null;

    const label = (typeof formatWatchItemLabel === 'function')
      ? formatWatchItemLabel({ showTitle: it.name, seasonNum: it.seasonNum, episodeNum: it.episodeNum, title: it.episodeTitle || '', isSeasonPremiere: isPremiere })
      : {
          title: it.name + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
          subtitle: it.episodeTitle || (isPremiere ? 'Season Premiere' : (isFinale ? 'Season Finale' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : '')))
        };
    return {
      id: it.id,
      type: 'series',
      name: label.title,
      subtitle: label.subtitle,
      poster: resolveListCardItemPoster(it),
      airDate: it.airDate,
      airTime: it.airTime || '',
      showId: it.showId || it.id,
      seasonNum: it.seasonNum,
      episodeNum: it.episodeNum,
      isUnaired: true,
      isSeasonPremiere: isPremiere,
      isSeasonFinale: isFinale,
      seasonFinaleAirDate: finaleAirDate,
    };
  });
  openListDetailsPage('MDBList Airing Next', 'series', 'mdblist:user:shows:airing-next', { sample: sample, count: sample.length, maybeMore: false });
}

// Renders the list cards into #myMdblistListsResult once /api/mdblist-my-lists
// returns.
function renderMyMdblistLists(lists) {
  window._myMdblistLists = lists || [];
  const box = document.getElementById('myMdblistListsResult');
  if (!lists || !lists.length) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>No lists found on your MDBList account.</small></p>';
    return;
  }

  const airingNextList = lists.find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
  if (airingNextList && Array.isArray(airingNextList.items) && airingNextList.items.length) {
    if (!window._mdblistRawAiringCandidates || !window._mdblistRawAiringCandidates.length) {
      window._mdblistRawAiringCandidates = airingNextList.items.map(it => ({ ...it }));
    }
    const localAiringList = (typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
    if (!airingNextList._cachedApplied) {
      try {
        const cached = JSON.parse(localStorage.getItem('myListAddon:mdblistAiringNextCache') || '[]');
        if (Array.isArray(cached) && cached.length) {
          const cacheMap = new Map(cached.map((c) => [c.id || c.imdbId || (c.tmdbId ? 'tmdb:' + c.tmdbId : ''), c]));
          airingNextList.items.forEach((it) => {
            const c = cacheMap.get(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : ''));
            const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
            if (c) {
              it.airDate = c.airDate;
              it.seasonNum = c.seasonNum;
              it.episodeNum = c.episodeNum;
              it.isSeasonPremiere = (typeof c.isSeasonPremiere === 'boolean') ? c.isSeasonPremiere : (localMatch ? localMatch.isSeasonPremiere : (c.episodeNum === 1));
              it.isSeasonFinale = !!(c.isSeasonFinale || (localMatch && localMatch.isSeasonFinale));
              it.seasonFinaleAirDate = c.seasonFinaleAirDate || (localMatch && localMatch.seasonFinaleAirDate) || null;
              it.seasonFinaleEpisodeNumber = c.seasonFinaleEpisodeNumber || null;
              it.isUnaired = true;
              it.episodeTitle = c.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.isSeasonFinale ? 'Season Finale' : (c.episodeNum != null ? ('Episode ' + c.episodeNum) : '')));
            } else if (localMatch) {
              it.isSeasonPremiere = !!localMatch.isSeasonPremiere;
              it.isSeasonFinale = !!localMatch.isSeasonFinale;
              it.seasonFinaleAirDate = localMatch.seasonFinaleAirDate || null;
            }
          });
        } else if (localAiringList.length) {
          airingNextList.items.forEach((it) => {
            const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
            if (localMatch) {
              it.isSeasonPremiere = !!localMatch.isSeasonPremiere;
              it.isSeasonFinale = !!localMatch.isSeasonFinale;
              it.seasonFinaleAirDate = localMatch.seasonFinaleAirDate || null;
            }
          });
        }
      } catch (e) {}
      airingNextList._cachedApplied = true;
    }
    const hasExpired = (airingNextList.items || []).some((it) => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
    if (!_mdblistAiringNextEnriching && (hasExpired || !_mdblistAiringNextEnrichedAt || Date.now() - _mdblistAiringNextEnrichedAt >= 120000)) {
      enrichMdblistAiringNextDates(airingNextList).catch(() => {});
    }
  }

  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const visibleLists = (typeof isListHidden === 'function') ? lists.filter((l) => !isListHidden(l && l.url)) : lists;

  const cardsHtml = visibleLists.map((l) => {
    const isUpNext = l.statusKey === 'upnext' || l.slug === 'upnext' || (l.url && (l.url === 'mdblist:user:shows:upnext' || l.url === 'mdblist:upnext' || l.url.includes(':upnext')));
    const isAiringNext = !isUpNext && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next')));
    const isHistory = !isUpNext && !isAiringNext && (l.slug === 'history' || l.url === 'mdblist:history' || String(l.url || '').indexOf('mdblist:history') !== -1 || String(l.url || '').indexOf('/history/') !== -1);
    const isWatchlist = !isUpNext && !isAiringNext && (l.slug === 'watchlist' || l.url === 'mdblist:watchlist');
    const isSingleType = isUpNext || isAiringNext || (!isHistory && !isWatchlist && (l.contentType === 'movie' || l.contentType === 'series'));
    const type = (isUpNext || isAiringNext || l.contentType === 'series') ? 'series' : 'movie';
    const typeLabel = isUpNext ? 'Shows' : (isAiringNext ? 'Shows' : (isHistory ? 'Watch History' : (isWatchlist ? 'Watch List' : (l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed')))));
    const viewType = isSingleType ? type : 'mixed';

    let filteredItems = l.items || [];
    if (isAiringNext) {
      filteredItems = filteredItems.filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
    }
    const totalCount = isAiringNext ? filteredItems.length : (l.items && typeof l.items === 'number' ? l.items : (Array.isArray(l.items) ? l.items.length : (l.itemCount || 0)));

    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="mixed">Copy</button>' +
        '<button type="button" class="lc-btn secondary" data-act="markMdblistHistoryAllWatched" data-act-args="[&quot;@self&quot;]">Mark all as Watched</button>'
      : (isUpNext
          ? '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">Copy</button>'
          : (isAiringNext
              ? '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">Copy</button>'
              : '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '">Copy</button>'));

    const targetType = isSingleType ? type : 'mixed';
    const isAdded = typeof isListAddedToConfig === 'function'
      ? (isListAddedToConfig(l.url, targetType) || isListAddedToConfig(null, targetType, l.url) || isListAddedToConfig(l.url, 'movie') || isListAddedToConfig(l.url, 'series') || isListAddedToConfig(l.url))
      : (alreadyAdded.has(l.url + '|' + targetType) || alreadyAdded.has(l.url + '|movie') || alreadyAdded.has(l.url + '|series'));
    const addBtns = '<button type="button" class="lc-btn list-add-btn secondary myListAddBtn' + (isAdded ? ' is-added' : '') + '" ' +
      (isAdded ? 'style="color:var(--danger);"' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(targetType) + '">' +
      (isAdded ? 'Remove' : '+ Add') +
    '</button>';

    const isCustomUserList = !isHistory && !isWatchlist && !isAiringNext && !isUpNext && !l.dynamic;
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn u-c-v_danger u-bdc-v_danger" data-provider="mdblist" data-list-id="' + escapeAttr(l.id || l.slug) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

    let postersHtml = '';
    if (isUpNext) {
      const previewItems = (l.items || []).slice(0, 9);
      if (previewItems.length) {
        postersHtml = '<div class="list-card-posters poster-preview-static">' +
          previewItems.map((it, i) => {
            const isMobileEnd = (i === 2 && previewItems.length > 3);
            const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
            let overlays = '';
            if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only u-cur-pointer" data-act="openMdblistUpNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';
            if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only u-cur-pointer" data-act="openMdblistUpNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';

            const showMdbUpNextBadges = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgesMdblistUpNext') : true;
            const showAirDate = showMdbUpNextBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true);
            const showPremiere = showMdbUpNextBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true);
            const showFinale = showMdbUpNextBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true);
            const showFinaleDate = showMdbUpNextBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true);

            const airingMatch = typeof findAiringMatchFor === 'function' ? findAiringMatchFor(it) : null;
            const effectiveAirDate = it.airDate || (airingMatch ? airingMatch.airDate : '');
            const hasAired = effectiveAirDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(effectiveAirDate) : false;
            const isUnairedEp = effectiveAirDate ? !hasAired : !!(it.isUnaired || (airingMatch && airingMatch.isUnaired));
            let dateBadge = '';
            if (showAirDate && effectiveAirDate && !hasAired && typeof isEpisodeAired === 'function') {
              dateBadge = typeof watchItemAirDateBadgeHtml === 'function' ? watchItemAirDateBadgeHtml({
                airDate: effectiveAirDate,
                airTime: it.airTime || (airingMatch && airingMatch.airTime) || '',
                showId: it.showId || it.id,
                seasonNum: it.seasonNum,
                episodeNum: it.episodeNum
              }) : '';
            }
            const isSeasonPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (airingMatch ? airingMatch.isSeasonPremiere : (it.episodeNum === 1));
            const isSeasonFinale = !!(it.isSeasonFinale || (airingMatch && airingMatch.isSeasonFinale));
            const seasonFinaleAirDate = it.seasonFinaleAirDate || (airingMatch ? (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : null)) : null);
            const isFinaleUnaired = seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(seasonFinaleAirDate) : !!seasonFinaleAirDate;
            let bottomBadge = '';
            if (isUnairedEp) {
              if (showPremiere && isSeasonPremiere) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(effectiveAirDate || '') + '">Season Premiere</div>';
              } else if (showFinale && isSeasonFinale) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(effectiveAirDate || '') + '">Season Finale</div>';
              } else if (showFinaleDate && seasonFinaleAirDate && isFinaleUnaired) {
                const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(seasonFinaleAirDate) : '';
                if (finaleText) {
                  bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
                }
              }
            }

            const poster = resolveListCardItemPoster(it);
            const epSubtitle = it.episodeTitle || (it.seasonNum != null && it.episodeNum != null ? ('S' + it.seasonNum + 'E' + it.episodeNum) : '');

            const mdbUpNextRemoveBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="mdblist" data-target="watchlist" data-list-id="watchlist" data-remove-id="' + escapeAttr(it.id || it.imdbId || '') + '" data-media-type="' + escapeAttr(it.type || 'series') + '" data-act="removeListItemFromDetails" data-act-stop data-act-args="[&quot;@self&quot;]" title="Remove from MDBList Watchlist" aria-label="Remove from MDBList Watchlist">\u2715</button>';
            return '<div class="list-card-mini-poster-tile mdblist-up-next-tile" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' +
              '<div class="list-card-mini-poster-img-wrap">' +
                (poster ? '<img src="' + escapeAttr(poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="series" data-title="' + escapeAttr(it.name || '') + '" data-poster="' + escapeAttr(poster || '') + '" data-imdb="' + escapeAttr(it.imdbId || it.id || '') + '" alt="" loading="lazy" data-act="handlePosterImgError" data-act-args="[&quot;@self&quot;]">' : '<div class="live-preview-poster live-preview-poster-placeholder u-bg-v_color_bg_sunken" data-needs-fallback="1" style="width:100%; height:100%;"><small class="u-c-v_muted u-fs-v_font_size_xs">No poster</small></div>') +
                (dateBadge + bottomBadge) +
                mdbUpNextRemoveBtn +
                overlays +
              '</div>' +
              '<div class="list-card-mini-poster-name">' + escapeHtml(it.name || it.title || 'Untitled') + '</div>' +
              (epSubtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(epSubtitle) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>';
      } else {
        postersHtml = '<p class="u-mt-8px u-c-v_muted"><small>No shows in progress.</small></p>';
      }
    } else if (isAiringNext) {
      const previewItems = filteredItems.slice(0, 9);
      if (previewItems.length) {
        postersHtml = '<div class="list-card-posters poster-preview-static">' +
          previewItems.map((it, i) => {
            const isMobileEnd = (i === 2 && previewItems.length > 3);
            const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
            let overlays = '';
            if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only u-cur-pointer" data-act="openMdblistAiringNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';
            if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only u-cur-pointer" data-act="openMdblistAiringNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';

            const showAiringBadges = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgesAiringNext') : true;
            const showAirDate = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true);
            const showPremiere = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true);
            const showFinale = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true);
            const showFinaleDate = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true);

            const hasAired = it.airDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(it.airDate) : false;
            const isUnairedEp = it.airDate ? !hasAired : !!it.isUnaired;
            let dateBadge = '';
            if (showAirDate && it.airDate && !hasAired && typeof isEpisodeAired === 'function') {
              dateBadge = typeof watchItemAirDateBadgeHtml === 'function' ? watchItemAirDateBadgeHtml(it) : '';
            }
            const isSeasonPremiere = (it.episodeNum === 1 || (it.episodeNum == null && it.isSeasonPremiere));
            const isFinaleUnaired = it.seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(it.seasonFinaleAirDate) : !!it.seasonFinaleAirDate;
            let bottomBadge = '';
            if (isUnairedEp) {
              if (showPremiere && isSeasonPremiere) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Premiere</div>';
              } else if (showFinale && it.isSeasonFinale) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Finale</div>';
              } else if (showFinaleDate && it.seasonFinaleAirDate && isFinaleUnaired) {
                const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(it.seasonFinaleAirDate) : '';
                if (finaleText) {
                  bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(it.seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
                }
              }
            }
            const label = (typeof formatWatchItemLabel === 'function')
              ? formatWatchItemLabel({ showTitle: it.name, seasonNum: it.seasonNum, episodeNum: it.episodeNum, title: it.episodeTitle || '', isSeasonPremiere: it.isSeasonPremiere })
              : {
                  title: it.name + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
                  subtitle: it.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : ''))
                };

            const poster = resolveListCardItemPoster(it);
            const mdbAiringNextRemoveBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="mdblist" data-target="watchlist" data-list-id="watchlist" data-remove-id="' + escapeAttr(it.id || it.imdbId || '') + '" data-media-type="' + escapeAttr(it.type || 'series') + '" data-act="removeListItemFromDetails" data-act-stop data-act-args="[&quot;@self&quot;]" title="Remove from MDBList Watchlist" aria-label="Remove from MDBList Watchlist">\u2715</button>';
            return '<div class="list-card-mini-poster-tile" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
              '<div class="list-card-mini-poster-img-wrap">' +
                (poster ? '<img src="' + escapeAttr(poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(it.type || type) + '" data-title="' + escapeAttr(it.name || '') + '" data-poster="' + escapeAttr(poster || '') + '" data-imdb="' + escapeAttr(it.imdbId || it.id || '') + '" alt="" loading="lazy" data-act="handlePosterImgError" data-act-args="[&quot;@self&quot;]">' : '<div class="live-preview-poster live-preview-poster-placeholder u-bg-v_color_bg_sunken" data-needs-fallback="1" style="width:100%; height:100%;"><small class="u-c-v_muted u-fs-v_font_size_xs">No poster</small></div>') +
                (dateBadge + bottomBadge) +
                mdbAiringNextRemoveBtn +
                overlays +
              '</div>' +
              '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
              (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>';
      } else if (_mdblistAiringNextEnriching) {
        postersHtml = '<p class="u-mt-8px u-c-v_muted u-fs-v_font_size_sm"><span class="u-bd-2px_solid_v_accent u-bordertopcolor-transparent u-br-50 u-va-middle u-mr-6px" style="display:inline-block; width:12px; height:12px; animation:spin 0.8s linear infinite;"></span>Checking upcoming air dates&hellip;</p>';
      } else {
        postersHtml = '<p class="u-mt-8px u-c-v_muted"><small>Nothing scheduled yet.</small></p>';
      }
    } else {
      postersHtml = '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>';
    }

    const titleClick = isUpNext ? 'data-act="openMdblistUpNextDetailsPage"' : (isAiringNext ? 'data-act="openMdblistAiringNextDetailsPage"' : '');

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(viewType) + '" data-creator="MDBList" data-items="' + escapeAttr(totalCount) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title u-cur-pointer" ' + titleClick + '>' + escapeHtml(l.name) + (l.dynamic ? ' <span class="badge">Dynamic</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span><span>' + totalCount + ' items</span>' +
            (!isHistory && !isWatchlist && !isAiringNext && !isUpNext ? '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          deleteBtn +
          addBtns +
        '</div>' +
      '</div>' +
      postersHtml +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml || '<p class="u-mt-10px u-c-v_muted"><small>All lists here are hidden. Manage visibility under Settings &rarr; Watchlist Preferences.</small></p>';
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

function handleMyListAddBtnClick(addBtn) {
  if (!addBtn || addBtn.disabled) return;
  addBtn.disabled = true;
  setTimeout(() => { try { addBtn.disabled = false; } catch (e) {} }, 400);
  const isAdded = addBtn.classList.contains('is-added');
  const name = addBtn.dataset.name || 'List';
  const url = addBtn.dataset.url;
  const type = addBtn.dataset.type || 'mixed';
  if (isAdded) {
    if (typeof removeListFromConfig === 'function') {
      removeListFromConfig(url, type);
      removeListFromConfig(url, 'movie');
      removeListFromConfig(url, 'series');
      removeListFromConfig(url, 'mixed');
      removeListFromConfig(url);
      removeListFromConfig(null, type, url);
    }
    if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
    if (typeof showAddedToast === 'function') showAddedToast('Removed "' + name + '" from your Catalogs.');
  } else {
    if (type === 'mixed') {
      addRow(name + ' (Movies)', url, 'movie', true, 'Custom');
      addRow(name + ' (Shows)', url, 'series', true, 'Custom');
    } else {
      addRow(name, url, type, true, 'Custom');
    }
    if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
    if (typeof showAddedToast === 'function') showAddedToast('Added "' + name + '" to your Catalogs.');
  }
}

document.getElementById('myMdblistListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn) {
    handleMyListAddBtnClick(addBtn);
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn, copyBtn.dataset.historyMode);
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
  }
});

async function runMyTraktLists() {
  const box = document.getElementById('myTraktListsResult');
  const isDisc = localStorage.getItem('myListAddon:traktDisconnected') === 'true';
  const token = isDisc ? '' : (traktAccessToken || readProviderSecret('myListAddon:traktAccessToken') || '');
  const neutralMsg = '<p class="u-mt-10px u-c-v_muted"><small>Connect your Trakt account in Settings or click <strong>Connect Trakt</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';

  if (!token) {
    if (box) box.innerHTML = neutralMsg;
    const privBox = document.getElementById('myPrivateTraktListsResult');
    if (privBox) privBox.innerHTML = '';
    return;
  }

  if (box) box.innerHTML = '';
  return runMyPrivateTraktLists();
}

function renderMyTraktLists(lists) {
  renderMyPrivateTraktLists(lists);
}

document.getElementById('myTraktListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn, .myPrivateListAddBtn');
  if (addBtn) {
    handleMyListAddBtnClick(addBtn);
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
  }
});

// --- MDBList OAuth (Connect MDBList) --------------------------------------
function startMdblistConnect() {
  if (!requireSignedInFor('connect your MDBList account')) return; // docs/DECISIONS.md D-8
  try { localStorage.removeItem('myListAddon:mdblistDisconnected'); } catch (e) {}
  window.location.href = ORIGIN + '/api/mdblist/oauth/start';
}

function disconnectMdblist() {
  forgetServerConnection('mdblist');
  const input = document.getElementById('mdblistKeyInput');
  if (input) input.value = '';
  mdblistAccessToken = '';
  try { window.mdblistAccessToken = ''; } catch (e) {}
  try {
    forgetProviderSecret('myListAddon:mdblistAccessToken');
    localStorage.removeItem('myListAddon:mdblistUsername');
    forgetProviderSecret('myListAddon:mdblistKey');
    localStorage.setItem('myListAddon:mdblistDisconnected', 'true');
  } catch (e) {}
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  renderMdblistConnectStatus();
  scheduleMyMdblistListsRefresh();
}

function toggleListsMdblistConnection() {
  const isDisc = localStorage.getItem('myListAddon:mdblistDisconnected') === 'true';
  const token = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || readProviderSecret('myListAddon:mdblistAccessToken');
  if (token && !isDisc) {
    disconnectMdblist();
  } else {
    startMdblistConnect();
  }
}

function renderMdblistConnectStatus() {
  const input = document.getElementById('mdblistKeyInput');
  const statusEl = document.getElementById('mdblistConnectStatus');
  const connectBtn = document.getElementById('mdblistConnectBtn');
  const disconnectBtn = document.getElementById('mdblistDisconnectBtn');
  const listsBtn = document.getElementById('listsMdblistConnectBtn');
  const isDisc = localStorage.getItem('myListAddon:mdblistDisconnected') === 'true';
  const token = isDisc ? '' : ((typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || readProviderSecret('myListAddon:mdblistAccessToken') || '');
  if (!isDisc && token) mdblistAccessToken = token;
  const user = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || (isDisc ? '' : (localStorage.getItem('myListAddon:mdblistUsername') || ''));
  const key = (input ? input.value.trim() : '') || (isDisc ? '' : (readProviderSecret('myListAddon:mdblistKey') || ''));
  const isAccountConnected = !isDisc && !!token;
  const hasKey = !isDisc && !!key;

  if (listsBtn) {
    listsBtn.innerText = isAccountConnected ? 'Disconnect' : 'Connect MDBList';
  }

  if (statusEl) {
    if (token && user) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (token) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">\u2713 Connected to MDBList</span>';
      if (!window._mdblistResolvingUser) {
        window._mdblistResolvingUser = true;
        setTimeout(() => {
          window._mdblistResolvingUser = false;
          if (typeof runMyMdblistLists === 'function') runMyMdblistLists();
        }, 100);
      }
    } else if (hasKey) {
      statusEl.innerHTML = '<span class="u-c-v_text_2 u-fw-600">Custom MDBList API Key configured</span>';
    } else {
      statusEl.innerHTML = '<span class="u-c-v_muted">Not connected.</span>';
    }
  }
  if (connectBtn) connectBtn.textContent = token ? 'Re-connect MDBList' : (key ? 'Update Key' : 'Connect MDBList Account');
  if (disconnectBtn) disconnectBtn.style.display = (isAccountConnected || hasKey) ? '' : 'none';

  const syncCb = document.getElementById('syncMdblistHistoryCheckbox');
  if (syncCb) syncCb.checked = localStorage.getItem('myListAddon:syncMdblistHistory') === 'true';
  const syncWrap = document.getElementById('mdblistSyncHistoryWrap');
  if (syncWrap) syncWrap.style.display = (isAccountConnected || hasKey) ? '' : 'none';

  if (!isAccountConnected && !hasKey) {
    const box = document.getElementById('myMdblistListsResult');
    if (box) box.innerHTML = '';
  }
}

// A newly connected MDBList account: from the address bar after a signed-out
// connect, or from the server after a signed-in one (pickUpServerConnection).
function applyMdblistConnection(token, username) {
  mdblistAccessToken = token;
  try {
    localStorage.removeItem('myListAddon:mdblistDisconnected');
  } catch (e) {}
  if (username) {
    mdblistUsername = username;
    try {
      localStorage.setItem('myListAddon:mdblistUsername', mdblistUsername);
    } catch (e) {}
  }
  try {
    rememberProviderSecret('myListAddon:mdblistAccessToken', mdblistAccessToken);
  } catch (e) {}
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  if (typeof showAppAlert === 'function') {
    showAppAlert('MDBList Connected', 'Connected to MDBList.', true);
  } else {
    showToast('Connected to MDBList.', 'success');
  }
  renderMdblistConnectStatus();
  scheduleMyMdblistListsRefresh();
}

function pickUpMdblistTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])mdblist_token=([^&]+)/.exec(hash);
  if (match) {
    const userMatch = /(?:^|[#&])mdblist_username=([^&]+)/.exec(hash);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    applyMdblistConnection(decodeURIComponent(match[1]), userMatch ? decodeURIComponent(userMatch[1]) : '');
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('mdblist_error');
  if (err) {
    const detail = params.get('mdblist_error_detail') || '';
    const messages = {
      not_configured: 'MDBList OAuth (MDBLIST_CLIENT_ID / MDBLIST_CLIENT_SECRET) is not configured in Cloudflare Secrets yet.',
      no_code: 'MDBList did not return an authorization code.',
      exchange_failed: 'Failed to exchange authorization code for an MDBList token.',
      access_denied: 'MDBList sign-in was cancelled.',
      state_mismatch: 'MDBList sign-in state mismatch. Please try again.',
      no_token: 'MDBList did not return an access token.',
      network: 'Network error connecting to MDBList.',
    };
    const msg = messages[err] || ('Could not connect to MDBList (' + err + (detail ? ': ' + detail : '') + ').');
    if (typeof showAppAlert === 'function') {
      showAppAlert('MDBList Connection Error', msg + (detail ? '\\n\\nDetails: ' + detail : ''), false);
    } else {
      showToast(msg + (detail ? '\\n' + detail : ''), 'error');
    }
    params.delete('mdblist_error');
    params.delete('mdblist_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

// --- Trakt OAuth (private lists) -----------------------------------------
//
// A full-page redirect (not a popup) -- Trakt's own login page doesn't
// need any special embedding, and a popup would need postMessage plumbing
// back to this window for no real benefit. /api/trakt/oauth/callback
// redirects back here with the resulting token in the URL fragment; see
// pickUpTraktTokenFromUrl below, called once from this page's own init.
function startTraktConnect() {
  if (!requireSignedInFor('connect your Trakt account')) return; // docs/DECISIONS.md D-8
  try { localStorage.removeItem('myListAddon:traktDisconnected'); } catch (e) {}
  window.location.href = ORIGIN + '/api/trakt/oauth/start';
}

function disconnectTrakt() {
  forgetServerConnection('trakt');
  const keyInput = document.getElementById('traktKeyInput');
  if (keyInput) keyInput.value = '';
  const userInput = document.getElementById('traktUsernameInput');
  if (userInput) userInput.value = '';
  traktAccessToken = '';
  try { window.traktAccessToken = ''; } catch (e) {}
  if (typeof activeTraktToken !== 'undefined') activeTraktToken = null;
  try {
    forgetProviderSecret('myListAddon:traktAccessToken');
    localStorage.removeItem('myListAddon:traktUsername');
    forgetProviderSecret('myListAddon:traktKey');
    localStorage.setItem('myListAddon:traktDisconnected', 'true');
  } catch (e) {}
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  renderTraktConnectStatus();
  const box = document.getElementById('myPrivateTraktListsResult');
  if (box) box.innerHTML = '';
  const pubBox = document.getElementById('myTraktListsResult');
  if (pubBox) pubBox.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>Connect your Trakt account in Settings or click <strong>Connect Trakt</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';
}

function toggleListsTraktConnection() {
  const isDisc = localStorage.getItem('myListAddon:traktDisconnected') === 'true';
  const token = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || readProviderSecret('myListAddon:traktAccessToken');
  if (token && !isDisc) {
    disconnectTrakt();
  } else {
    startTraktConnect();
  }
}

function renderTraktConnectStatus() {
  const keyInput = document.getElementById('traktKeyInput');
  const userInput = document.getElementById('traktUsernameInput');
  const statusEl = document.getElementById('traktConnectStatus');
  const connectBtn = document.getElementById('traktConnectBtn');
  const disconnectBtn = document.getElementById('traktDisconnectBtn');
  const listsBtn = document.getElementById('listsTraktConnectBtn');
  const isDisc = localStorage.getItem('myListAddon:traktDisconnected') === 'true';
  const token = isDisc ? '' : ((typeof traktAccessToken !== 'undefined' && traktAccessToken) || readProviderSecret('myListAddon:traktAccessToken') || '');
  if (!isDisc && token) traktAccessToken = token;
  const user = (userInput ? userInput.value.trim() : '') || (isDisc ? '' : (localStorage.getItem('myListAddon:traktUsername') || ''));
  const key = (keyInput ? keyInput.value.trim() : '') || (isDisc ? '' : (readProviderSecret('myListAddon:traktKey') || ''));
  const isAccountConnected = !isDisc && !!token;
  const hasKey = !isDisc && !!(key || user);
  
  if (listsBtn) {
    listsBtn.innerText = isAccountConnected ? 'Disconnect' : 'Connect Trakt';
  }
  
  if (statusEl) {
    if (token && user) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">✓ Connected as @' + escapeHtml(user) + '</span>';
    } else if (token) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">✓ Connected to Trakt</span>';
    } else if (hasKey) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">✓ Custom Trakt Client ID configured' + (user ? ' (@' + escapeHtml(user) + ')' : '') + '</span>';
    } else {
      statusEl.innerHTML = '<span class="u-c-v_muted">Not connected.</span>';
    }
  }
  if (connectBtn) connectBtn.textContent = token ? 'Re-connect Trakt' : (key ? 'Update Client ID' : 'Connect Trakt Account');
  if (disconnectBtn) disconnectBtn.style.display = (isAccountConnected || hasKey) ? '' : 'none';

  const syncCb = document.getElementById('syncTraktHistoryCheckbox');
  if (syncCb) syncCb.checked = localStorage.getItem('myListAddon:syncTraktHistory') === 'true';
  const syncWrap = document.getElementById('traktSyncHistoryWrap');
  if (syncWrap) syncWrap.style.display = (isAccountConnected || hasKey) ? '' : 'none';

  const box = document.getElementById('myPrivateTraktListsResult');
  const pubBox = document.getElementById('myTraktListsResult');
  if (!isAccountConnected) {
    if (box) box.innerHTML = '';
    if (pubBox) pubBox.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>Connect your Trakt account in Settings or click <strong>Connect Trakt</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';
  }
}

// Reads the token handed back in the URL fragment right after
// /api/trakt/oauth/callback redirects here (#trakt_token=...) -- a
// fragment, not a query param, since fragments never reach any server on
// subsequent requests. Also surfaces a plain message for ?trakt_error=...,
// the callback's own failure path. Either way, strips whatever it found
// from the address bar immediately so a page refresh or a copied/shared
// URL never carries it forward.
// A newly connected Trakt account: from the address bar after a signed-out
// connect, or from the server after a signed-in one (pickUpServerConnection).
function applyTraktConnection(token, user) {
  traktAccessToken = token;
  try {
    rememberProviderSecret('myListAddon:traktAccessToken', traktAccessToken);
    localStorage.removeItem('myListAddon:traktDisconnected');
  } catch (e) {}
  if (user) {
    try {
      localStorage.setItem('myListAddon:traktUsername', user);
    } catch (e) {}
    const uInput = document.getElementById('traktUsernameInput');
    if (uInput) uInput.value = user;
  }
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  if (typeof showAppAlert === 'function') {
    showAppAlert('Trakt Connected', 'Connected to Trakt.', true);
  } else {
    showToast('Connected to Trakt.', 'success');
  }
  renderTraktConnectStatus();
  scheduleMyTraktListsRefresh();
}

function pickUpTraktTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])trakt_token=([^&]+)/.exec(hash);
  if (match) {
    const userMatch = /(?:^|[#&])trakt_username=([^&]+)/.exec(hash);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    applyTraktConnection(decodeURIComponent(match[1]), userMatch ? decodeURIComponent(userMatch[1]) : '');
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('trakt_error');
  if (err) {
    const detail = params.get('trakt_error_detail') || '';
    const messages = {
      no_client_id: 'Trakt OAuth Client ID is not configured on this server.',
      no_code: 'Trakt did not return an authorization code.',
      token_exchange_failed: 'Failed to exchange authorization code for a Trakt token.',
      access_denied: 'Trakt sign-in was cancelled.',
    };
    const isRateLimit = detail.includes('1015') || detail.includes('429') || err === 'exchange_failed';
    const msg = isRateLimit 
      ? 'Trakt web redirect was rate-limited by Cloudflare (1015). Opening direct PIN code activation instead...'
      : (messages[err] || ('Could not connect to Trakt (' + err + (detail ? ': ' + detail : '') + ').'));

    if (typeof showAppAlert === 'function') {
      showAppAlert('Trakt Connection', msg, !isRateLimit);
    } else {
      showToast(msg, 'error');
    }
    params.delete('trakt_error');
    params.delete('trakt_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));

    if (isRateLimit) {
      setTimeout(() => {
        startTraktDeviceLogin();
      }, 500);
    }
  }
}

let _traktDevicePollTimer = null;

function closeTraktDeviceModal() {
  if (_traktDevicePollTimer) {
    clearInterval(_traktDevicePollTimer);
    _traktDevicePollTimer = null;
  }
  const modal = document.getElementById('traktDeviceModal');
  if (modal) modal.style.display = 'none';
}

// The connect code, asked for from this browser first. Trakt answers the
// code request without any secret, and from a page as well (it allows other
// sites to call it), so the request goes out from the visitor's own
// connection. Asked through the Worker it shares the site's one address with
// every catalog the site loads from Trakt, and Trakt limits that address: the
// "Trakt is busy (rate limit)" that stopped Connect with PIN on 2026-10-06.
// The Worker route stays as the fallback (a browser that cannot reach Trakt,
// or a page without the app id). Returns { status, data } like the route.
async function requestTraktDeviceCode(traktKey) {
  const clientId = traktKey || (typeof TRAKT_PUBLIC_CLIENT_ID === 'string' ? TRAKT_PUBLIC_CLIENT_ID : '');
  if (clientId) {
    try {
      const direct = await fetch('https://api.trakt.tv/oauth/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId },
        body: JSON.stringify({ client_id: clientId }),
      });
      if (direct.ok) {
        const data = await direct.json();
        if (data && data.user_code && data.device_code) return { status: 200, data: Object.assign({ ok: true }, data) };
      }
    } catch (e) {}
  }
  const res = await fetch(ORIGIN + '/api/trakt/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ traktKey: traktKey }),
  });
  return { status: res.status, data: await res.json() };
}

async function startTraktDeviceLogin(retried) {
  if (!requireSignedInFor('connect your Trakt account')) return; // docs/DECISIONS.md D-8
  const modal = document.getElementById('traktDeviceModal');
  const codeEl = document.getElementById('traktDeviceUserCode');
  const statusEl = document.getElementById('traktDevicePollingStatus');
  const linkEl = document.getElementById('traktDeviceActivateLink');
  const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || readProviderSecret('myListAddon:traktKey') || '';
  
  if (modal) modal.style.display = 'flex';
  if (codeEl) codeEl.innerText = 'LOADING...';
  if (statusEl) statusEl.innerText = 'Requesting activation code from Trakt...';

  try {
    const got = await requestTraktDeviceCode(traktKey);
    const data = got.data || {};
    // Trakt rate-limits the code request now and then. The server hands the
    // 429 straight back rather than sleeping inside the request; wait out a
    // short Retry-After once here and ask again. A long one is said as it is
    // (the server's message names the wait) rather than retried too early.
    if (got.status === 429 && !retried && (Number(data.retryAfter) || 2) <= 30) {
      const waitSec = Math.max(1, Number(data.retryAfter) || 2);
      if (statusEl) statusEl.innerText = 'Trakt is busy. Trying again in ' + waitSec + ' seconds...';
      setTimeout(() => { startTraktDeviceLogin(true); }, waitSec * 1000);
      return;
    }
    if (!data.ok || !data.user_code) {
      if (codeEl) codeEl.innerText = 'ERROR';
      if (statusEl) {
        statusEl.innerHTML = '<span class="u-c-v_danger">' + escapeHtml(data.error || 'Could not get device code.') + '</span> <button type="button" class="lc-btn secondary u-ml-8px u-p-3px_8px u-fs-v_font_size_xs" data-act="startTraktDeviceLogin">Try Again</button>';
      }
      return;
    }

    if (codeEl) codeEl.innerText = data.user_code;
    if (linkEl) {
      linkEl.href = data.verification_url || 'https://trakt.tv/activate';
    }
    if (statusEl) {
      statusEl.innerHTML = '<span class="u-c-v_accent u-fw-600">Code ready!</span> Enter code at trakt.tv/activate &bull; Waiting for approval...';
    }

    const deviceCode = data.device_code;
    const intervalSec = Math.max(4, data.interval || 5);
    const expiresAt = Date.now() + ((data.expires_in || 600) * 1000);

    if (_traktDevicePollTimer) clearInterval(_traktDevicePollTimer);

    _traktDevicePollTimer = setInterval(async () => {
      if (Date.now() > expiresAt) {
        clearInterval(_traktDevicePollTimer);
        _traktDevicePollTimer = null;
        if (statusEl) statusEl.innerHTML = 'Activation code expired. <button type="button" class="lc-btn secondary u-ml-8px u-p-3px_8px u-fs-v_font_size_xs" data-act="startTraktDeviceLogin">Get New Code</button>';
        return;
      }

      try {
        const pollRes = await fetch(ORIGIN + '/api/trakt/device/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: deviceCode, traktKey: traktKey }),
        });
        const pollData = await pollRes.json();

        if (pollData.ok && pollData.access_token) {
          clearInterval(_traktDevicePollTimer);
          _traktDevicePollTimer = null;
          traktAccessToken = pollData.access_token;
          try {
            rememberProviderSecret('myListAddon:traktAccessToken', traktAccessToken);
          } catch(e) {}
          if (pollData.username) {
            try {
              localStorage.setItem('myListAddon:traktUsername', pollData.username);
            } catch(e) {}
            const uInput = document.getElementById('traktUsernameInput');
            if (uInput) uInput.value = pollData.username;
          }
          saveState();
          if (typeof pushCreatorSync === 'function') pushCreatorSync();
          closeTraktDeviceModal();
          if (typeof showAppAlert === 'function') {
            showAppAlert('Trakt Connected', 'Successfully connected to Trakt' + (pollData.username ? ' as @' + pollData.username : '') + '.', true);
          }
          renderTraktConnectStatus();
          scheduleMyTraktListsRefresh();
        } else if (pollData.pending) {
          // Still waiting for user confirmation
        } else if (pollData.slowDown) {
          // Trakt is limiting the Worker's checks. The code stays good for
          // its ten minutes and the next check may get through, so keep
          // going, but say why an approval has not shown up yet.
          if (statusEl) statusEl.innerText = 'Trakt is answering slowly. If you have entered the code, this can take a minute or two to finish.';
        } else if (pollData.error && !pollData.pending) {
          clearInterval(_traktDevicePollTimer);
          _traktDevicePollTimer = null;
          if (statusEl) statusEl.innerText = pollData.error;
        }
      } catch (e) {}
    }, intervalSec * 1000);

  } catch (err) {
    if (codeEl) codeEl.innerText = 'ERROR';
    if (statusEl) statusEl.innerHTML = 'Network error requesting device code. <button type="button" class="lc-btn secondary u-ml-8px u-p-3px_8px u-fs-v_font_size_xs" data-act="startTraktDeviceLogin">Try Again</button>';
  }
}

async function runMyPrivateTraktLists() {
  const box = document.getElementById('myPrivateTraktListsResult');
  if (!box) return;
  if (!traktAccessToken) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p class="u-mt-10px"><small>Loading your Trakt lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/trakt-my-private-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: traktAccessToken }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Trakt lists.') + '</p>';
      return;
    }
    if (data.username) {
      traktUsername = data.username;
      try {
        localStorage.setItem('myListAddon:traktUsername', traktUsername);
        localStorage.removeItem('myListAddon:traktDisconnected');
      } catch (e) {}
      const uInput = document.getElementById('traktUsernameInput');
      if (uInput && !uInput.value) uInput.value = traktUsername;
      renderTraktConnectStatus();
    }
    renderMyPrivateTraktLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your Trakt lists.</p>';
  }
}

let _traktAiringNextEnriching = false;
let _traktAiringNextEnrichedAt = 0;
async function enrichTraktAiringNextDates(list) {
  if (!list || !Array.isArray(list.items) || !list.items.length) return;
  const hasExpired = (list.items || []).some((it) => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
  if (!hasExpired && _traktAiringNextEnrichedAt && (Date.now() - _traktAiringNextEnrichedAt < 300000)) return;
  _traktAiringNextEnriching = true;

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || readProviderSecret('myListAddon:tmdbKey') || '';

  try {
    const rawCandidates = (window._traktRawAiringCandidates && window._traktRawAiringCandidates.length)
      ? window._traktRawAiringCandidates
      : (list.items || []);
    const candidates = rawCandidates.slice(0, 80);
    const enriched = [];
    const concurrency = 5;
    for (let i = 0; i < candidates.length; i += concurrency) {
      const chunk = candidates.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (it) => {
        try {
          const showId = it.imdbId || (it.id && String(it.id).startsWith('tt') ? it.id : '') || (it.tmdbId ? 'tmdb:' + it.tmdbId : (it.id ? (String(it.id).startsWith('tmdb:') ? it.id : 'tmdb:' + it.id) : ''));
          if (!showId) return;
          const bypass = hasExpired ? '&fresh=1&_t=' + Date.now() : '';
          const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(showId) + '&type=series&tmdbKey=' + encodeURIComponent(tmdbKey) + bypass);
          const data = await res.json();
          const d = data && data.ok ? data.details : null;
          if (d && d.nextEpisodeAirDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(d.nextEpisodeAirDate))) {
            it.airDate = d.nextEpisodeAirDate;
            it.seasonNum = d.nextEpisodeSeasonNumber;
            it.episodeNum = d.nextEpisodeNumber;
            it.isSeasonPremiere = (typeof d.isSeasonPremiere === 'boolean') ? d.isSeasonPremiere : (d.nextEpisodeNumber === 1);
            it.isSeasonFinale = !!d.isSeasonFinale;
            it.seasonFinaleAirDate = d.seasonFinaleAirDate || null;
            it.seasonFinaleEpisodeNumber = d.seasonFinaleEpisodeNumber || null;
            it.isUnaired = true;
            it.episodeTitle = d.nextEpisodeName || (it.isSeasonPremiere ? 'Season Premiere' : (it.isSeasonFinale ? 'Season Finale' : ('Episode ' + d.nextEpisodeNumber)));
            enriched.push(it);
          }
        } catch (e) {}
      }));
    }
    if (enriched.length) {
      enriched.sort((a, b) => (a.airDate || '').localeCompare(b.airDate || ''));
      list.items = enriched;
      list.itemCount = enriched.length;
      try {
        localStorage.setItem('myListAddon:traktAiringNextCache', JSON.stringify(enriched));
      } catch (e) {}
      _traktAiringNextEnrichedAt = Date.now();
      renderMyPrivateTraktLists(window._myPrivateTraktLists || window._myTraktLists);
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
    }
  } finally {
    _traktAiringNextEnriching = false;
  }
}

function openTraktContinueWatchingDetailsPage() {
  const lists = window._myPrivateTraktLists || window._myTraktLists || [];
  const list = lists.find((l) => l && (l.statusKey === 'continue-watching' || l.slug === 'continue-watching' || (l.url && (l.url === 'trakt:continue-watching' || l.url.includes(':continue-watching')))));
  if (!list) return;
  const sample = (list.items || []).map((it) => {
    const sNum = it.seasonNum;
    const eNum = it.episodeNum;
    const epSubtitle = it.episodeTitle || (sNum != null && eNum != null ? ('S' + sNum + 'E' + eNum) : '');
    const airingMatch = typeof findAiringMatchFor === 'function' ? findAiringMatchFor(it) : null;
    const isPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (airingMatch ? airingMatch.isSeasonPremiere : (eNum === 1));
    const isFinale = !!(it.isSeasonFinale || (airingMatch && airingMatch.isSeasonFinale));
    const finaleAirDate = it.seasonFinaleAirDate || (airingMatch ? (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : null)) : null);
    const finaleEpNum = it.seasonFinaleEpisodeNumber || (airingMatch ? airingMatch.seasonFinaleEpisodeNumber : null);
    const effectiveAirDate = it.airDate || (airingMatch ? airingMatch.airDate : '');
    return {
      id: it.id,
      type: it.type || 'series',
      name: it.title || it.name || 'Untitled',
      subtitle: epSubtitle,
      poster: resolveListCardItemPoster(it),
      progress: it.progress,
      showId: it.showId || it.id,
      seasonNum: sNum,
      episodeNum: eNum,
      airDate: effectiveAirDate,
      airTime: it.airTime || (airingMatch ? airingMatch.airTime : ''),
      isUnaired: effectiveAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(effectiveAirDate) : !!(it.isUnaired || (airingMatch && airingMatch.isUnaired)),
      isSeasonPremiere: isPremiere,
      isSeasonFinale: isFinale,
      seasonFinaleAirDate: finaleAirDate,
      seasonFinaleEpisodeNumber: finaleEpNum,
      removeExternalProvider: 'trakt',
      removeExternalTarget: 'history',
      removeExternalListId: 'history',
    };
  });
  openListDetailsPage('Trakt Continue Watching', 'mixed', 'trakt:continue-watching', { sample: sample, count: sample.length, maybeMore: false, creatorName: 'Trakt' }, { creatorName: 'Trakt' });
}

function openTraktAiringNextDetailsPage() {
  const lists = window._myPrivateTraktLists || window._myTraktLists || [];
  const list = lists.find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
  if (!list) return;
  const filtered = (list.items || []).filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
  const localAiringList = (typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
  const sample = filtered.map((it) => {
    const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
    const isPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (localMatch ? localMatch.isSeasonPremiere : (it.episodeNum === 1));
    const isFinale = !!(it.isSeasonFinale || (localMatch && localMatch.isSeasonFinale));
    const finaleAirDate = it.seasonFinaleAirDate || (localMatch && localMatch.seasonFinaleAirDate) || null;

    const label = (typeof formatWatchItemLabel === 'function')
      ? formatWatchItemLabel({ showTitle: it.name, seasonNum: it.seasonNum, episodeNum: it.episodeNum, title: it.episodeTitle || '', isSeasonPremiere: isPremiere })
      : {
          title: it.name + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
          subtitle: it.episodeTitle || (isPremiere ? 'Season Premiere' : (isFinale ? 'Season Finale' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : '')))
        };
    return {
      id: it.id,
      type: 'series',
      name: label.title,
      subtitle: label.subtitle,
      poster: resolveListCardItemPoster(it),
      airDate: it.airDate,
      airTime: it.airTime || '',
      showId: it.showId || it.id,
      seasonNum: it.seasonNum,
      episodeNum: it.episodeNum,
      isUnaired: true,
      isSeasonPremiere: isPremiere,
      isSeasonFinale: isFinale,
      seasonFinaleAirDate: finaleAirDate,
      removeExternalProvider: 'trakt',
      removeExternalTarget: 'watchlist',
      removeExternalListId: 'watchlist',
    };
  });
  openListDetailsPage('Trakt Airing Next', 'series', 'trakt:user:shows:airing-next', { sample: sample, count: sample.length, maybeMore: false, creatorName: 'Trakt' }, { creatorName: 'Trakt' });
}

// Every row here -- public or private -- becomes a perfectly normal
// trakt.tv list URL once added (see collectEntries/fetchTrakt): the
// connected access token travels with every Trakt fetch this config makes
// from here on (see the dispatch in fetchCatalog), not just ones added
// from this specific panel, so a private list keeps resolving correctly
// wherever it's referenced.
function renderMyPrivateTraktLists(lists) {
  window._myPrivateTraktLists = lists || [];
  const box = document.getElementById('myPrivateTraktListsResult');
  if (!lists || !lists.length) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>No lists found on your Trakt account.</small></p>';
    return;
  }

  const airingNextList = lists.find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
  if (airingNextList && Array.isArray(airingNextList.items) && airingNextList.items.length) {
    if (!window._traktRawAiringCandidates || !window._traktRawAiringCandidates.length) {
      window._traktRawAiringCandidates = airingNextList.items.map(it => ({ ...it }));
    }
    const localAiringList = (typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
    if (!airingNextList._cachedApplied) {
      try {
        const cached = JSON.parse(localStorage.getItem('myListAddon:traktAiringNextCache') || '[]');
        if (Array.isArray(cached) && cached.length) {
          const cacheMap = new Map(cached.map((c) => [c.id || c.imdbId || (c.tmdbId ? 'tmdb:' + c.tmdbId : ''), c]));
          airingNextList.items.forEach((it) => {
            const c = cacheMap.get(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : ''));
            const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
            if (c) {
              it.airDate = c.airDate;
              it.seasonNum = c.seasonNum;
              it.episodeNum = c.episodeNum;
              it.isSeasonPremiere = (typeof c.isSeasonPremiere === 'boolean') ? c.isSeasonPremiere : (localMatch ? localMatch.isSeasonPremiere : (c.episodeNum === 1));
              it.isSeasonFinale = !!(c.isSeasonFinale || (localMatch && localMatch.isSeasonFinale));
              it.seasonFinaleAirDate = c.seasonFinaleAirDate || (localMatch && localMatch.seasonFinaleAirDate) || null;
              it.seasonFinaleEpisodeNumber = c.seasonFinaleEpisodeNumber || null;
              it.isUnaired = true;
              it.episodeTitle = c.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.isSeasonFinale ? 'Season Finale' : (c.episodeNum != null ? ('Episode ' + c.episodeNum) : '')));
            } else if (localMatch) {
              it.isSeasonPremiere = !!localMatch.isSeasonPremiere;
              it.isSeasonFinale = !!localMatch.isSeasonFinale;
              it.seasonFinaleAirDate = localMatch.seasonFinaleAirDate || null;
            }
          });
        } else if (localAiringList.length) {
          airingNextList.items.forEach((it) => {
            const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
            if (localMatch) {
              it.isSeasonPremiere = !!localMatch.isSeasonPremiere;
              it.isSeasonFinale = !!localMatch.isSeasonFinale;
              it.seasonFinaleAirDate = localMatch.seasonFinaleAirDate || null;
            }
          });
        }
      } catch (e) {}
      airingNextList._cachedApplied = true;
    }
    const hasExpired = (airingNextList.items || []).some((it) => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
    if (!_traktAiringNextEnriching && (hasExpired || !_traktAiringNextEnrichedAt || Date.now() - _traktAiringNextEnrichedAt >= 120000)) {
      enrichTraktAiringNextDates(airingNextList).catch(() => {});
    }
  }

  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const visibleLists = (typeof isListHidden === 'function') ? lists.filter((l) => !isListHidden(l && l.url)) : lists;

  const cardsHtml = visibleLists.map((l) => {
    const isContinueWatching = l.statusKey === 'continue-watching' || l.slug === 'continue-watching' || (l.url && (l.url === 'trakt:continue-watching' || l.url.includes(':continue-watching')));
    const isAiringNext = !isContinueWatching && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next')));
    const isHistory = !isContinueWatching && !isAiringNext && (l.url === 'trakt:history' || l.slug === 'history');
    const isWatchlist = !isContinueWatching && !isAiringNext && (l.url === 'trakt:watchlist' || l.slug === 'watchlist');
    const isSingleType = isAiringNext || (!isContinueWatching && (l.contentType === 'movie' || l.contentType === 'series'));
    const type = (isAiringNext || l.contentType === 'series') ? 'series' : 'movie';
    const typeLabel = isContinueWatching ? 'Continue Watching' : (isAiringNext ? 'Shows' : (isHistory ? 'Watch History' : (isWatchlist ? 'Watch List' : (l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed')))));
    const viewType = isSingleType ? type : 'mixed';

    let filteredItems = l.items || [];
    if (isAiringNext) {
      filteredItems = filteredItems.filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
    }
    const totalCount = isAiringNext ? filteredItems.length : (l.items && typeof l.items === 'number' ? l.items : (Array.isArray(l.items) ? l.items.length : (l.itemCount || 0)));

    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="mixed">Copy</button>' +
        '<button type="button" class="lc-btn secondary" data-act="markTraktHistoryAllWatched" data-act-args="[&quot;@self&quot;]">Mark all as Watched</button>'
      : (isContinueWatching
          ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="mixed">Copy</button>'
          : (isAiringNext
              ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">Copy</button>'
              : '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '">Copy</button>'));

    const targetType = isSingleType ? type : 'mixed';
    const isAdded = typeof isListAddedToConfig === 'function'
      ? (isListAddedToConfig(l.url, targetType) || isListAddedToConfig(null, targetType, l.url) || isListAddedToConfig(l.url, 'movie') || isListAddedToConfig(l.url, 'series') || isListAddedToConfig(l.url))
      : (alreadyAdded.has(l.url + '|' + targetType) || alreadyAdded.has(l.url + '|movie') || alreadyAdded.has(l.url + '|series'));
    const addBtns = '<button type="button" class="lc-btn list-add-btn secondary myListAddBtn myPrivateListAddBtn' + (isAdded ? ' is-added' : '') + '" ' +
      (isAdded ? 'style="color:var(--danger);"' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(targetType) + '">' +
      (isAdded ? 'Remove' : '+ Add') +
    '</button>';

    const isCustomUserList = !isHistory && !isWatchlist && !isAiringNext && !isContinueWatching;
    const traktListId = (l.ids && l.ids.trakt) || l.id || l.slug || '';
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn u-c-v_danger u-bdc-v_danger" data-provider="trakt" data-list-id="' + escapeAttr(traktListId) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

    let postersHtml = '';
    if (isContinueWatching) {
      const previewItems = (l.items || []).slice(0, 9);
      if (previewItems.length) {
        postersHtml = '<div class="list-card-posters poster-preview-static">' +
          previewItems.map((it, i) => {
            const isMobileEnd = (i === 2 && previewItems.length > 3);
            const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
            let overlays = '';
            if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only u-cur-pointer" data-act="openTraktContinueWatchingDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';
            if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only u-cur-pointer" data-act="openTraktContinueWatchingDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';

            const showTraktCwBadges = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgesTraktContinueWatching') : true;
            const showAirDate = showTraktCwBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true);
            const showPremiere = showTraktCwBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true);
            const showFinale = showTraktCwBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true);
            const showFinaleDate = showTraktCwBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true);

            const airingMatch = typeof findAiringMatchFor === 'function' ? findAiringMatchFor(it) : null;
            const effectiveAirDate = it.airDate || (airingMatch ? airingMatch.airDate : '');
            const hasAired = effectiveAirDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(effectiveAirDate) : false;
            const isUnairedEp = effectiveAirDate ? !hasAired : !!(it.isUnaired || (airingMatch && airingMatch.isUnaired));
            let dateBadge = '';
            if (showAirDate && effectiveAirDate && !hasAired && typeof isEpisodeAired === 'function') {
              dateBadge = typeof watchItemAirDateBadgeHtml === 'function' ? watchItemAirDateBadgeHtml({
                airDate: effectiveAirDate,
                airTime: it.airTime || (airingMatch && airingMatch.airTime) || '',
                showId: it.showId || it.id,
                seasonNum: it.seasonNum,
                episodeNum: it.episodeNum
              }) : '';
            }
            const isSeasonPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (airingMatch ? airingMatch.isSeasonPremiere : (it.episodeNum === 1));
            const isSeasonFinale = !!(it.isSeasonFinale || (airingMatch && airingMatch.isSeasonFinale));
            const seasonFinaleAirDate = it.seasonFinaleAirDate || (airingMatch ? (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : null)) : null);
            const isFinaleUnaired = seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(seasonFinaleAirDate) : !!seasonFinaleAirDate;
            let bottomBadge = '';
            if (isUnairedEp) {
              if (showPremiere && isSeasonPremiere) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(effectiveAirDate || '') + '">Season Premiere</div>';
              } else if (showFinale && isSeasonFinale) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(effectiveAirDate || '') + '">Season Finale</div>';
              } else if (showFinaleDate && seasonFinaleAirDate && isFinaleUnaired) {
                const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(seasonFinaleAirDate) : '';
                if (finaleText) {
                  bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
                }
              }
            }

            const traktPoster = resolveListCardItemPoster(it);
            const progPercent = Math.min(100, Math.max(0, it.progress || 0));
            const progressOverlay = progPercent > 0
              ? '<div class="playback-progress-bar u-bg-rgba_0_0_0_0_5" style="position:absolute; bottom:0; left:0; right:0; height:4px; z-index:2;"><div style="width:' + progPercent + '%; height:100%; background:var(--accent);"></div></div>'
              : '';

            const epSubtitle = it.episodeTitle || (it.seasonNum != null && it.episodeNum != null ? ('S' + it.seasonNum + 'E' + it.episodeNum) : '');

            return '<div class="list-card-mini-poster-tile trakt-continue-watching-tile" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(it.type || 'mixed') + '">' +
              '<div class="list-card-mini-poster-img-wrap">' +
                (traktPoster ? '<img src="' + escapeAttr(traktPoster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(it.type || 'series') + '" data-title="' + escapeAttr(it.name || '') + '" data-poster="' + escapeAttr(traktPoster || '') + '" data-imdb="' + escapeAttr(it.imdbId || it.id || '') + '" alt="" loading="lazy" data-act="handlePosterImgError" data-act-args="[&quot;@self&quot;]">' : '<div class="live-preview-poster live-preview-poster-placeholder u-bg-v_color_bg_sunken" data-needs-fallback="1" style="width:100%; height:100%;"><small class="u-c-v_muted u-fs-v_font_size_xs">No poster</small></div>') +
                progressOverlay +
                (dateBadge + bottomBadge) +
                '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="trakt" data-target="history" data-list-id="history" data-remove-id="' + escapeAttr(it.id || it.imdbId || '') + '" data-media-type="' + escapeAttr(it.type || 'series') + '" data-act="removeListItemFromDetails" data-act-stop data-act-args="[&quot;@self&quot;]" title="Remove from Trakt History" aria-label="Remove from Trakt History">\u2715</button>' +
                overlays +
              '</div>' +
              '<div class="list-card-mini-poster-name">' + escapeHtml(it.name || it.title || 'Untitled') + '</div>' +
              (epSubtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(epSubtitle) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>';
      } else {
        postersHtml = '<p class="u-mt-8px u-c-v_muted"><small>Nothing in progress.</small></p>';
      }
    } else if (isAiringNext) {
      const previewItems = filteredItems.slice(0, 9);
      if (previewItems.length) {
        postersHtml = '<div class="list-card-posters poster-preview-static">' +
          previewItems.map((it, i) => {
            const isMobileEnd = (i === 2 && previewItems.length > 3);
            const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
            let overlays = '';
            if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only u-cur-pointer" data-act="openTraktAiringNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';
            if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only u-cur-pointer" data-act="openTraktAiringNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';

            const showAiringBadges = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgesAiringNext') : true;
            const showAirDate = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true);
            const showPremiere = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true);
            const showFinale = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true);
            const showFinaleDate = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true);

            const hasAired = it.airDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(it.airDate) : false;
            const isUnairedEp = it.airDate ? !hasAired : !!it.isUnaired;
            let dateBadge = '';
            if (showAirDate && it.airDate && !hasAired && typeof isEpisodeAired === 'function') {
              dateBadge = typeof watchItemAirDateBadgeHtml === 'function' ? watchItemAirDateBadgeHtml(it) : '';
            }
            const isSeasonPremiere = (it.episodeNum === 1 || (it.episodeNum == null && it.isSeasonPremiere));
            const isFinaleUnaired = it.seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(it.seasonFinaleAirDate) : !!it.seasonFinaleAirDate;
            let bottomBadge = '';
            if (isUnairedEp) {
              if (showPremiere && isSeasonPremiere) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Premiere</div>';
              } else if (showFinale && it.isSeasonFinale) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Finale</div>';
              } else if (showFinaleDate && it.seasonFinaleAirDate && isFinaleUnaired) {
                const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(it.seasonFinaleAirDate) : '';
                if (finaleText) {
                  bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(it.seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
                }
              }
            }
            const label = (typeof formatWatchItemLabel === 'function')
              ? formatWatchItemLabel({ showTitle: it.name, seasonNum: it.seasonNum, episodeNum: it.episodeNum, title: it.episodeTitle || '', isSeasonPremiere: it.isSeasonPremiere })
              : {
                  title: it.name + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
                  subtitle: it.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : ''))
                };

            const traktPoster = resolveListCardItemPoster(it);
            return '<div class="list-card-mini-poster-tile" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
              '<div class="list-card-mini-poster-img-wrap">' +
                (traktPoster ? '<img src="' + escapeAttr(traktPoster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(it.type || type) + '" data-title="' + escapeAttr(it.name || '') + '" data-poster="' + escapeAttr(traktPoster || '') + '" data-imdb="' + escapeAttr(it.imdbId || it.id || '') + '" alt="" loading="lazy" data-act="handlePosterImgError" data-act-args="[&quot;@self&quot;]">' : '<div class="live-preview-poster live-preview-poster-placeholder u-bg-v_color_bg_sunken" data-needs-fallback="1" style="width:100%; height:100%;"><small class="u-c-v_muted u-fs-v_font_size_xs">No poster</small></div>') +
                (dateBadge + bottomBadge) +
                '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="trakt" data-target="watchlist" data-list-id="watchlist" data-remove-id="' + escapeAttr(it.id || it.imdbId || '') + '" data-media-type="' + escapeAttr(it.type || 'series') + '" data-act="removeListItemFromDetails" data-act-stop data-act-args="[&quot;@self&quot;]" title="Remove from Trakt Watchlist" aria-label="Remove from Trakt Watchlist">\u2715</button>' +
                overlays +
              '</div>' +
              '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
              (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>';
      } else if (_traktAiringNextEnriching) {
        postersHtml = '<p class="u-mt-8px u-c-v_muted u-fs-v_font_size_sm"><span class="u-bd-2px_solid_v_accent u-bordertopcolor-transparent u-br-50 u-va-middle u-mr-6px" style="display:inline-block; width:12px; height:12px; animation:spin 0.8s linear infinite;"></span>Checking upcoming air dates&hellip;</p>';
      } else {
        postersHtml = '<p class="u-mt-8px u-c-v_muted"><small>Nothing scheduled yet.</small></p>';
      }
    } else {
      postersHtml = '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>';
    }

    const titleClick = isContinueWatching ? 'data-act="openTraktContinueWatchingDetailsPage"' : (isAiringNext ? 'data-act="openTraktAiringNextDetailsPage"' : '');

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(viewType) + '" data-creator="Trakt" data-items="' + escapeAttr(totalCount) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title u-cur-pointer" ' + titleClick + '>' + escapeHtml(l.name) + (l.private && !isWatchlist && !isHistory && !isAiringNext && !isContinueWatching ? ' <span class="badge">Private</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span><span>' + totalCount + ' items</span>' +
            (!isHistory && !isWatchlist && !isAiringNext && !isContinueWatching ? '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          deleteBtn +
          addBtns +
        '</div>' +
      '</div>' +
      postersHtml +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml || '<p class="u-mt-10px u-c-v_muted"><small>All lists here are hidden. Manage visibility under Settings &rarr; Watchlist Preferences.</small></p>';
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myPrivateTraktListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myPrivateListAddBtn, .myListAddBtn');
  if (addBtn) {
    handleMyListAddBtnClick(addBtn);
    return;
  }
  const copyBtn = e.target.closest('.myPrivateListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn, copyBtn.dataset.historyMode);
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
  }
});

// --- TMDB Account / API Key Connection -----------------------------------
let tmdbSessionId = '';
let tmdbAccountId = '';
let tmdbUsername = '';

function onTmdbKeyInputChanged() {
  const input = document.getElementById('tmdbKeyInput');
  const val = input ? input.value.trim() : '';
  if (val) {
    rememberProviderSecret('myListAddon:tmdbKey', val);
  } else {
    forgetProviderSecret('myListAddon:tmdbKey');
  }
  renderTmdbConnectStatus();
  scheduleMyTmdbListsRefresh();
}

function startTmdbConnect() {
  if (!requireSignedInFor('connect your TMDB account')) return; // docs/DECISIONS.md D-8
  try { localStorage.removeItem('myListAddon:tmdbDisconnected'); } catch (e) {}
  window.location.href = ORIGIN + '/api/tmdb/oauth/start';
}

function toggleListsTmdbConnection() {
  const isDisc = localStorage.getItem('myListAddon:tmdbDisconnected') === 'true';
  const sess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || readProviderSecret('myListAddon:tmdbSessionId');
  if (sess && !isDisc) {
    disconnectTmdb();
  } else {
    startTmdbConnect();
  }
}

function disconnectTmdb() {
  forgetServerConnection('tmdb');
  const input = document.getElementById('tmdbKeyInput');
  if (input) input.value = '';
  tmdbSessionId = '';
  try { window.tmdbSessionId = ''; } catch (e) {}
  tmdbAccountId = '';
  try { window.tmdbAccountId = ''; } catch (e) {}
  tmdbUsername = '';
  try { window.tmdbUsername = ''; } catch (e) {}
  try {
    forgetProviderSecret('myListAddon:tmdbKey');
    forgetProviderSecret('myListAddon:tmdbSessionId');
    localStorage.removeItem('myListAddon:tmdbAccountId');
    localStorage.removeItem('myListAddon:tmdbUsername');
    localStorage.setItem('myListAddon:tmdbDisconnected', 'true');
  } catch (e) {}
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  renderTmdbConnectStatus();
  scheduleMyTmdbListsRefresh();
}

// A newly connected TMDB account: from the address bar after a signed-out
// connect, or from the server after a signed-in one (pickUpServerConnection).
function applyTmdbConnection(sess, acc, user) {
  tmdbSessionId = sess;
  tmdbAccountId = acc || '';
  tmdbUsername = user || '';
  try {
    localStorage.removeItem('myListAddon:tmdbDisconnected');
    rememberProviderSecret('myListAddon:tmdbSessionId', tmdbSessionId);
    if (tmdbAccountId) localStorage.setItem('myListAddon:tmdbAccountId', tmdbAccountId);
    if (tmdbUsername) localStorage.setItem('myListAddon:tmdbUsername', tmdbUsername);
  } catch (e) {}
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  renderTmdbConnectStatus();
  scheduleMyTmdbListsRefresh();
}

function pickUpTmdbTokenFromUrl() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#') && hash.includes('tmdb_session=')) {
    const params = new URLSearchParams(hash.slice(1));
    const sess = params.get('tmdb_session');
    const acc = params.get('tmdb_account');
    const user = params.get('tmdb_user');
    if (sess) {
      params.delete('tmdb_session');
      params.delete('tmdb_account');
      params.delete('tmdb_user');
      const rem = params.toString();
      history.replaceState(null, '', window.location.pathname + window.location.search + (rem ? '#' + rem : ''));
      applyTmdbConnection(sess, acc, user);
    }
  }

  const search = new URLSearchParams(window.location.search);
  const err = search.get('tmdb_error');
  if (err) {
    const detail = search.get('tmdb_error_detail') || '';
    const msg = 'Could not connect to TMDB (' + err + (detail ? ': ' + detail : '') + ').';
    if (typeof showAppAlert === 'function') {
      showAppAlert('TMDB Connection Error', msg, false);
    } else {
      showToast(msg, 'error');
    }
    search.delete('tmdb_error');
    search.delete('tmdb_error_detail');
    const qs = search.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
  }
}

function renderTmdbConnectStatus() {
  const input = document.getElementById('tmdbKeyInput');
  const statusEl = document.getElementById('tmdbConnectStatus');
  const connectBtn = document.getElementById('tmdbConnectBtn');
  const disconnectBtn = document.getElementById('tmdbDisconnectBtn');
  const listsConnectBtn = document.getElementById('listsTmdbConnectBtn');

  const isDisc = localStorage.getItem('myListAddon:tmdbDisconnected') === 'true';
  const sess = isDisc ? '' : (tmdbSessionId || readProviderSecret('myListAddon:tmdbSessionId') || '');
  const user = isDisc ? '' : (tmdbUsername || localStorage.getItem('myListAddon:tmdbUsername') || '');
  const key = (input ? input.value.trim() : '') || (isDisc ? '' : (readProviderSecret('myListAddon:tmdbKey') || ''));
  const isAccountConnected = !isDisc && !!sess;
  const hasKey = !isDisc && !!key;

  if (statusEl) {
    if (sess && user) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (sess) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">\u2713 TMDB Account Connected</span>';
    } else if (hasKey) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text">\u2713 Custom TMDB Key configured</span>';
    } else {
      statusEl.innerHTML = '<span class="u-c-v_muted">Not connected</span>';
    }
  }

  if (connectBtn) connectBtn.textContent = sess ? 'Re-connect TMDB' : (key ? 'Update Key' : 'Connect TMDB Account');
  if (disconnectBtn) disconnectBtn.style.display = (isAccountConnected || hasKey) ? '' : 'none';
  if (listsConnectBtn) listsConnectBtn.textContent = isAccountConnected ? 'Disconnect' : 'Connect TMDB';

  if (!isAccountConnected && !hasKey) {
    const box = document.getElementById('myTmdbListsResult');
    if (box) box.innerHTML = '';
  }
}

let myTmdbListsTimer = null;
function scheduleMyTmdbListsRefresh() {
  clearTimeout(myTmdbListsTimer);
  myTmdbListsTimer = setTimeout(runMyTmdbLists, 600);
}

async function runMyTmdbLists() {
  const box = document.getElementById('myTmdbListsResult');
  if (!box) return;
  const sess = tmdbSessionId || readProviderSecret('myListAddon:tmdbSessionId') || '';
  const acc = tmdbAccountId || localStorage.getItem('myListAddon:tmdbAccountId') || '';
  const input = document.getElementById('tmdbKeyInput');
  const key = (input ? input.value.trim() : '') || readProviderSecret('myListAddon:tmdbKey') || '';

  if (!sess && !acc) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>Connect your TMDB account in Settings or click <strong>Connect TMDB</strong> above to see your personal lists, watchlist, and favorites here.</small></p>';
    return;
  }

  box.innerHTML = '<p class="u-mt-10px"><small>Loading your TMDB lists\u2026</small></p>';
  try {
    // POST: the TMDB session id is a credential and is never put in a URL.
    const res = await fetch(ORIGIN + '/api/tmdb-my-lists', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sess || '', accountId: acc || '', tmdbKey: key || '' }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: 'Server returned HTTP ' + res.status };
    }
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your TMDB lists.') + '</p>';
      return;
    }
    if (data.username) {
      tmdbUsername = data.username;
      try {
        localStorage.setItem('myListAddon:tmdbUsername', tmdbUsername);
        if (data.accountId) {
          tmdbAccountId = String(data.accountId);
          localStorage.setItem('myListAddon:tmdbAccountId', tmdbAccountId);
        }
        localStorage.removeItem('myListAddon:tmdbDisconnected');
      } catch (e) {}
      renderTmdbConnectStatus();
    }
    renderMyTmdbLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your TMDB lists: ' + escapeHtml(e && e.message ? e.message : String(e)) + '</p>';
  }
}

function renderMyTmdbLists(lists) {
  window._myTmdbLists = lists || [];
  const box = document.getElementById('myTmdbListsResult');
  if (!box) return;
  if (!lists || !lists.length) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>No lists found on your TMDB account.</small></p>';
    return;
  }

  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const visibleLists = (typeof isListHidden === 'function') ? lists.filter((l) => !isListHidden(l && l.url)) : lists;

  const cardsHtml = visibleLists.map((l) => {
    const listIdStr = String(l.id || '');
    const listUrlStr = String(l.url || '');
    const isWatchlist = listIdStr.includes('watchlist') || listUrlStr.includes('watchlist');
    const isFavorites = listIdStr.includes('favorites') || listUrlStr.includes('favorites');
    const isSingleType = l.contentType === 'movie' || l.contentType === 'series';
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = isWatchlist ? 'Watchlist' : (isFavorites ? 'Favorites' : (l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed')));

    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'mixed') + '">Copy</button>';

    const targetType = isSingleType ? type : 'mixed';
    const isAdded = typeof isListAddedToConfig === 'function'
      ? (isListAddedToConfig(l.url, targetType) || isListAddedToConfig(null, targetType, l.url) || isListAddedToConfig(l.url, 'movie') || isListAddedToConfig(l.url, 'series') || isListAddedToConfig(l.url))
      : (alreadyAdded.has(l.url + '|' + targetType) || alreadyAdded.has(l.url + '|movie') || alreadyAdded.has(l.url + '|series'));
    const addBtns = '<button type="button" class="lc-btn list-add-btn secondary myListAddBtn' + (isAdded ? ' is-added' : '') + '" ' +
      (isAdded ? 'style="color:var(--danger);"' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(targetType) + '">' +
      (isAdded ? 'Remove' : '+ Add') +
    '</button>';

    const previewItems = (l.previewItems || []).filter(it => it.poster);
    let posterThumbs = '';
    if (previewItems.length) {
      const totalCount = l.items || previewItems.length;
      posterThumbs = '<div class="list-card-posters poster-preview-static">' +
        previewItems.map((it, i) => {
          const isMobileEnd = (i === 2 && previewItems.length > 3);
          const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
          let overlays = '';
          if (isMobileEnd) {
            overlays += '<div class="list-card-count-overlay mobile-only u-cur-default">' + totalCount + ' &rsaquo;</div>';
          }
          if (isDesktopEnd) {
            overlays += '<div class="list-card-count-overlay desktop-only u-cur-default">' + totalCount + ' &rsaquo;</div>';
          }
          const posterType = it.type || (l.contentType === 'series' ? 'series' : 'movie');
          const tmdbTarget = isWatchlist ? 'watchlist' : (isFavorites ? 'favorite' : 'custom');
          const tmdbListId = isWatchlist ? 'watchlist' : (isFavorites ? 'favorite' : listIdStr);
          const removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="tmdb" data-target="' + tmdbTarget + '" data-list-id="' + escapeAttr(tmdbListId) + '" data-remove-id="' + escapeAttr(it.id) + '" data-media-type="' + escapeAttr(posterType) + '" data-act="removeListItemFromDetails" data-act-stop data-act-args="[&quot;@self&quot;]" title="Remove from TMDB" aria-label="Remove from TMDB">\u2715</button>';
          const tmdbPoster = typeof resolveClientPoster === 'function' ? resolveClientPoster(it, it.poster) : it.poster;
          const ratingSpan = typeof formatRatingSpanHtml === 'function' ? formatRatingSpanHtml(it) : '';
          return '<div class="list-card-mini-poster-tile">' +
            '<div class="list-card-mini-poster-img-wrap">' +
              '<img src="' + escapeAttr(tmdbPoster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
              removeBtn +
              overlays +
            '</div>' +
            '<div class="list-card-mini-poster-name">' + escapeHtml(it.title || '') + '</div>' +
            ((it.year || ratingSpan) ? '<div class="list-card-mini-poster-year u-ai-center u-jc-space_between u-gap-4px" style="display:flex; width:100%;"><span>' + escapeHtml(it.year ? String(it.year) : '') + '</span>' + ratingSpan + '</div>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }

    const isCustomUserList = !isWatchlist && !isFavorites;
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn u-c-v_danger u-bdc-v_danger" data-provider="tmdb" data-list-id="' + escapeAttr(listIdStr) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + (l.private ? ' <span class="badge">Private</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          deleteBtn +
          addBtns +
        '</div>' +
      '</div>' +
      posterThumbs +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml || '<p class="u-mt-10px u-c-v_muted"><small>All lists here are hidden. Manage visibility under Settings &rarr; Watchlist Preferences.</small></p>';
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
}

document.getElementById('myTmdbListsResult')?.addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn) {
    handleMyListAddBtnClick(addBtn);
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
  }
});
// --- Simkl OAuth & Personal Lists -----------------------------------------
function startSimklConnect() {
  if (!requireSignedInFor('connect your Simkl account')) return; // docs/DECISIONS.md D-8
  try { localStorage.removeItem('myListAddon:simklDisconnected'); } catch (e) {}
  window.location.href = ORIGIN + '/api/simkl/oauth/start';
}

function disconnectSimkl() {
  forgetServerConnection('simkl');
  const input = document.getElementById('simklKeyInput');
  if (input) input.value = '';
  simklAccessToken = '';
  try { window.simklAccessToken = ''; } catch (e) {}
  simklUsername = '';
  try { window.simklUsername = ''; } catch (e) {}
  window._mySimklLists = [];
  try {
    forgetProviderSecret('myListAddon:simklAccessToken');
    localStorage.removeItem('myListAddon:simklUsername');
    forgetProviderSecret('myListAddon:simklKey');
    localStorage.setItem('myListAddon:simklDisconnected', 'true');
  } catch (e) {}
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  renderSimklConnectStatus();
  scheduleMySimklListsRefresh();
}

function toggleListsSimklConnection() {
  const isDisc = localStorage.getItem('myListAddon:simklDisconnected') === 'true';
  const token = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || readProviderSecret('myListAddon:simklAccessToken');
  if (token && !isDisc) {
    disconnectSimkl();
  } else {
    startSimklConnect();
  }
}

// A newly connected Simkl account: from the address bar after a signed-out
// connect, or from the server after a signed-in one (pickUpServerConnection).
function applySimklConnection(token, username) {
  simklAccessToken = token;
  try {
    localStorage.removeItem('myListAddon:simklDisconnected');
    rememberProviderSecret('myListAddon:simklAccessToken', simklAccessToken);
  } catch (e) {}
  if (username) {
    simklUsername = username;
    try {
      localStorage.setItem('myListAddon:simklUsername', simklUsername);
    } catch (e) {}
  }
  saveState();
  if (typeof pushCreatorSync === 'function') pushCreatorSync();
  if (typeof showAppAlert === 'function') {
    showAppAlert('Simkl Connected', 'Your Simkl account was successfully connected.', true);
  } else {
    showToast('Connected to Simkl.', 'success');
  }
  renderSimklConnectStatus();
  scheduleMySimklListsRefresh();
}

// --- Connections kept on the server (P3a-9) ----------------------------------
//
// Signed in, connecting Trakt, MDBList, Simkl or TMDB keeps the token on the
// server and comes back as ?connected=<provider>, with no token in the address
// bar. This page still works from its own copy of each token, so it asks for
// that one once, over the signed-in session, and hands it to the same code a
// token in the address bar reaches.
async function pickUpServerConnection() {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get('connected');
  if (!provider) return;
  let data = null;
  let reached = false;
  try {
    const res = await fetch(ORIGIN + '/api/connections/' + encodeURIComponent(provider) + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    reached = true;
    data = await res.json();
  } catch (e) {}
  // Left in the address bar only when the server could not be reached, so a
  // reload tries again.
  if (reached) {
    params.delete('connected');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
  }
  if (!data || !data.ok || !data.accessToken) {
    const msg = reached
      ? 'That account could not be loaded. Please connect it again from Settings.'
      : 'Your account was connected, but this page could not load it. Reload the page to try again.';
    if (typeof showAppAlert === 'function') showAppAlert('Connection', msg, false);
    else showToast(msg, 'error');
    return;
  }
  if (provider === 'trakt') applyTraktConnection(data.accessToken, data.username || '');
  else if (provider === 'mdblist') applyMdblistConnection(data.accessToken, data.username || '');
  else if (provider === 'simkl') applySimklConnection(data.accessToken, data.username || '');
  else if (provider === 'tmdb') applyTmdbConnection(data.accessToken, data.id || '', data.username || '');
}

// A connection the server could not renew (token.refresh, P5-7) asks to be
// connected again. Once per page load, and only signed in.
async function warnAboutLapsedConnections() {
  if (typeof isSignedIn === 'function' && !isSignedIn()) return;
  let data = null;
  try {
    const res = await fetch(ORIGIN + '/api/connections');
    if (!res.ok) return;
    data = await res.json();
  } catch (e) {
    return;
  }
  const names = { trakt: 'Trakt', mdblist: 'MDBList', simkl: 'Simkl', tmdb: 'TMDB', stremio: 'Stremio', nuvio: 'Nuvio' };
  const lapsed = ((data && data.connections) || [])
    .filter(function (c) { return c && c.status && c.status !== 'ok'; })
    .map(function (c) { return names[c.provider] || c.provider; });
  if (!lapsed.length) return;
  showToast(lapsed.join(' and ') + ' asked to be signed in again. Reconnect it in Settings to keep those rows filled.', 'error', { duration: 15000 });
}

// Disconnecting removes the server's copy too. Harmless when there is none, or
// when this browser has no session (the server answers 401).
function forgetServerConnection(provider) {
  try {
    fetch(ORIGIN + '/api/connections/' + encodeURIComponent(provider), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  } catch (e) {}
}

// Once per account on this device, and only once the browser has a session
// (/api/creator/restore says so): offers the provider tokens this browser
// already holds to the server, which checks each with its provider and keeps
// the good ones.
async function importLocalConnectionsOnce(creatorName) {
  if (!creatorName || typeof collectKeys !== 'function') return;
  const flag = 'myListAddon:connectionsImported:' + String(creatorName).toLowerCase();
  try {
    if (localStorage.getItem(flag) === '1') return;
  } catch (e) {
    return;
  }
  const k = collectKeys();
  const keys = {
    traktAccessToken: k.traktAccessToken, traktKey: k.traktKey, traktUsername: k.traktUsername,
    mdblistAccessToken: k.mdblistAccessToken, mdblistKey: k.mdblistKey, mdblistUsername: k.mdblistUsername,
    simklAccessToken: k.simklAccessToken, simklKey: k.simklKey, simklUsername: k.simklUsername,
    tmdbSessionId: k.tmdbSessionId, tmdbKey: k.tmdbKey, tmdbAccountId: k.tmdbAccountId, tmdbUsername: k.tmdbUsername,
  };
  if (!keys.traktAccessToken && !keys.mdblistAccessToken && !keys.mdblistKey && !keys.simklAccessToken && !keys.tmdbSessionId) {
    try { localStorage.setItem(flag, '1'); } catch (e) {}
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/connections/import-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: keys }),
    });
    const data = await res.json();
    // Finished once every token has had an answer about itself. One whose
    // provider could not be reached is offered again on a later visit.
    if (data && data.ok) {
      const pending = Object.values(data.results || {}).some((r) => r === 'unreachable' || r === 'failed');
      if (!pending) localStorage.setItem(flag, '1');
    }
  } catch (e) {}
}

function pickUpSimklTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])simkl_token=([^&]+)/.exec(hash);
  if (match) {
    const userMatch = /(?:^|[#&])simkl_username=([^&]+)/.exec(hash);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    applySimklConnection(decodeURIComponent(match[1]), userMatch ? decodeURIComponent(userMatch[1]) : '');
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('simkl_error');
  if (err) {
    const detail = params.get('simkl_error_detail') || '';
    const messages = {
      not_configured: 'Simkl sign-in is temporarily unavailable. Please try again later.',
      no_code: 'Simkl did not return an authorization code.',
      exchange_failed: 'Failed to exchange authorization code for a Simkl token.',
      access_denied: 'Simkl sign-in was cancelled.',
      state_mismatch: 'Simkl sign-in state mismatch. Please try again.',
      no_token: 'Simkl did not return an access token.',
      network: 'Network error connecting to Simkl.',
    };
    const msg = messages[err] || ('Could not connect to Simkl (' + err + (detail ? ': ' + detail : '') + ').');
    if (typeof showAppAlert === 'function') {
      showAppAlert('Simkl Connection Error', msg + (detail ? '\\n\\nDetails: ' + detail : ''), false);
    } else {
      showToast(msg + (detail ? '\\n' + detail : ''), 'error');
    }
    params.delete('simkl_error');
    params.delete('simkl_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

function renderSimklConnectStatus() {
  const input = document.getElementById('simklKeyInput');
  const statusEl = document.getElementById('simklConnectStatus');
  const connectBtn = document.getElementById('simklConnectBtn');
  const disconnectBtn = document.getElementById('simklDisconnectBtn');
  const listsBtn = document.getElementById('listsSimklConnectBtn');

  const isDisc = localStorage.getItem('myListAddon:simklDisconnected') === 'true';
  const token = isDisc ? '' : ((typeof simklAccessToken !== 'undefined' && simklAccessToken) || readProviderSecret('myListAddon:simklAccessToken') || '');
  if (!isDisc && token) simklAccessToken = token;
  const user = (typeof simklUsername !== 'undefined' && simklUsername) || (isDisc ? '' : (localStorage.getItem('myListAddon:simklUsername') || ''));
  const key = (input ? input.value.trim() : '') || (isDisc ? '' : (readProviderSecret('myListAddon:simklKey') || ''));
  const isAccountConnected = !isDisc && !!token;
  const hasKey = !isDisc && !!key;

  if (listsBtn) {
    listsBtn.innerText = isAccountConnected ? 'Disconnect' : 'Connect Simkl';
  }

  if (statusEl) {
    if (token && user) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (token) {
      statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">\u2713 Connected to Simkl</span>';
    } else if (hasKey) {
      statusEl.innerHTML = '<span class="u-c-v_text_2 u-fw-600">Custom Simkl Client ID configured</span> <small class="u-c-v_muted">(Account not connected)</small>';
    } else {
      statusEl.innerHTML = '<span class="u-c-v_muted">Not connected.</span>';
    }
  }

  if (connectBtn) connectBtn.textContent = token ? 'Re-connect Simkl' : (key ? 'Update Client ID' : 'Connect Simkl Account');
  if (disconnectBtn) disconnectBtn.style.display = (isAccountConnected || hasKey) ? '' : 'none';

  const syncCb = document.getElementById('syncSimklHistoryCheckbox');
  if (syncCb) syncCb.checked = localStorage.getItem('myListAddon:syncSimklHistory') === 'true';
  const syncWrap = document.getElementById('simklSyncHistoryWrap');
  if (syncWrap) syncWrap.style.display = (isAccountConnected || hasKey) ? '' : 'none';

  if (!isAccountConnected && !hasKey) {
    const box = document.getElementById('mySimklListsResult');
    if (box) box.innerHTML = '';
  }
}

// --- Stremio and Nuvio accounts (61_media-app-sync.js) --------------------------
//
// The sign-in stays on the server: Stremio is approved inside Stremio (the Link
// flow) and Nuvio's password is sent once and not kept. This page only shows the
// connection and its settings, over the signed-in session. It holds no token.
const MEDIA_APP_UI_NAMES = { stremio: 'Stremio', nuvio: 'Nuvio' };
let mediaAppUiPoll = null;
// Whether each app is connected and working, from its settings answer.
const mediaAppListsLive = { stremio: false, nuvio: false };
// An update is under way / when the page last asked for one, per app. A copy older than
// this is brought up to date when Lists is looked at (61_media-app-sync.js, refreshMediaAppNow).
const mediaAppListsBusy = { stremio: false, nuvio: false };
const mediaAppUpdateTried = { stremio: 0, nuvio: 0 };
const MEDIA_APP_UI_FRESH_MS = 2 * 60 * 1000;
// The lists each app offers under Lists, My Lists. The server serves them as
// autotrack:<app>-<slug>:<movie|series>:<username> rows (fetchAutoTrackedCatalog, 05_).
const MEDIA_APP_LISTS = [
  { slug: 'watch-history', title: 'Watch History', blurb: 'Movies and shows you watched there.' },
  { slug: 'continue-watching', title: 'Continue Watching', blurb: 'Where you stopped there: movies part way through and the next episode of your shows.' },
];

async function mediaAppUiCall(provider, sub, method, body) {
  try {
    const res = await fetch(ORIGIN + '/api/connections/' + provider + (sub ? '/' + sub : ''), {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const data = await res.json().catch(function () { return {}; });
    return { ok: res.ok && data.ok !== false, status: res.status, data: data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } };
  }
}

// The server's message, with the reason it gives (what is missing, what the service answered) after it.
function mediaAppUiMessage(r, fallback) {
  const d = r && r.data ? r.data : {};
  return (d.error || fallback) + (d.detail ? ' (' + d.detail + ')' : '');
}

// Brings the copy up to date, in the request, when it is older than two minutes, and
// then shows what it found. Once per two minutes at most, so a pull that cannot be done
// does not repeat every time the lists are drawn.
function mediaAppUiMaybeUpdate(provider, sync) {
  if (mediaAppListsBusy[provider]) return;
  const now = Date.now();
  if (sync.lastPullAt && now - sync.lastPullAt < MEDIA_APP_UI_FRESH_MS) return;
  if (now - mediaAppUpdateTried[provider] < MEDIA_APP_UI_FRESH_MS) return;
  mediaAppUpdateTried[provider] = now;
  mediaAppListsBusy[provider] = true;
  mediaAppUiCall(provider, 'sync', 'POST', { wait: true }).then(function () {
    mediaAppListsBusy[provider] = false;
    mediaAppUiRefresh(provider);
  });
}

function mediaAppUiSyncLine(sync) {
  if (!sync) return '';
  if (sync.error) return sync.error;
  if (sync.lastPullAt) {
    let line = 'Last checked ' + new Date(sync.lastPullAt).toLocaleString() + '.';
    const r = sync.lastResult;
    if (r) {
      line += ' Found ' + r.found + (r.found === 1 ? ' title.' : ' titles.');
      if (r.unresolved) line += ' ' + r.unresolved + ' could not be matched.';
    }
    return line;
  }
  return 'Waiting for the first check…';
}

function mediaAppListUrls(provider, slug) {
  const user = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName) || '';
  if (!user) return null;
  const base = 'autotrack:' + provider + '-' + slug + ':';
  return { movie: base + 'movie:' + user, series: base + 'series:' + user, mixed: base + 'mixed:' + user };
}

// The cards under Lists, My Lists. Shown once the app is connected.
function renderMediaAppLists(provider) {
  const name = MEDIA_APP_UI_NAMES[provider];
  const box = document.getElementById('my' + name + 'ListsResult');
  if (!box) return;
  if (!mediaAppListsLive[provider]) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>Connect ' + name + ' in Settings, under External Accounts, to see its lists here.</small></p>';
    return;
  }
  if (mediaAppListsBusy[provider]) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted" role="status"><small>Updating from ' + name + '\u2026</small></p>';
    return;
  }
  box.innerHTML = MEDIA_APP_LISTS.map(function (l) {
    const urls = mediaAppListUrls(provider, l.slug);
    const added = !!urls && typeof isListAddedToConfig === 'function' && isListAddedToConfig(urls.movie, 'movie') && isListAddedToConfig(urls.series, 'series');
    const listName = name + ' ' + l.title;
    return '<div class="list-card" data-list-type="mixed" data-name="' + escapeAttr(listName) + '"' + (urls ? ' data-url="' + escapeAttr(urls.mixed) + '"' : '') + '>' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title u-cur-pointer" data-act="openMediaAppListDetails" data-act-args="' + appActArgs([provider, l.slug]) + '">' + escapeHtml(listName) + '</div>' +
          '<div class="list-card-meta"><span>' + escapeHtml(l.blurb) + '</span></div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn list-add-btn secondary' + (added ? ' is-added' : '') + '"' + (added ? ' style="color:var(--danger);"' : '') +
            ' data-act="toggleMediaAppListAdd" data-act-args="' + appActArgs([provider, l.slug, added]) + '">' + (added ? 'Remove' : '+ Add') + '</button>' +
        '</div>' +
      '</div>' +
      (urls ? '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(urls.mixed) + '" data-type="mixed" data-creator="" data-items="" data-likes="0"></div>' : '') +
    '</div>';
  }).join('');
  // Fills each card's posters, like the other services' cards.
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

// Opens the list's details page: its movies and shows together.
function openMediaAppListDetails(provider, slug) {
  const urls = mediaAppListUrls(provider, slug);
  const meta = MEDIA_APP_LISTS.filter(function (l) { return l.slug === slug; })[0];
  if (!urls || !meta) return;
  openListDetailsPage(MEDIA_APP_UI_NAMES[provider] + ' ' + meta.title, 'mixed', urls.mixed);
}

// Adds or removes the list's two catalog rows, one for movies and one for shows.
function toggleMediaAppListAdd(provider, slug, isAdded) {
  if (!requireSignedInFor('add your ' + MEDIA_APP_UI_NAMES[provider] + ' lists')) return;
  const urls = mediaAppListUrls(provider, slug);
  const meta = MEDIA_APP_LISTS.filter(function (l) { return l.slug === slug; })[0];
  if (!urls || !meta) return;
  const name = MEDIA_APP_UI_NAMES[provider] + ' ' + meta.title;
  if (isAdded) {
    removeListFromConfig(urls.movie, 'movie');
    removeListFromConfig(urls.series, 'series');
    if (typeof showAddedToast === 'function') showAddedToast('Removed "' + name + '" from your Catalogs.');
  } else {
    addRow(name + ' (Movies)', urls.movie, 'movie', true, 'My Lists');
    addRow(name + ' (Shows)', urls.series, 'series', true, 'My Lists');
    if (typeof showAddedToast === 'function') showAddedToast('Added "' + name + '" to your Catalogs.');
  }
  renderMediaAppLists(provider);
  if (typeof renderCollectionsMediaApps === 'function') renderCollectionsMediaApps();
}

// info: the settings answer, or null when signed out or unavailable.
function renderMediaAppStatus(provider, info) {
  const name = MEDIA_APP_UI_NAMES[provider];
  const connected = !!(info && info.connected);
  const lapsed = connected && !!info.status && info.status !== 'ok';
  const live = connected && !lapsed;
  mediaAppListsLive[provider] = live;
  if (live) mediaAppUiMaybeUpdate(provider, info.sync || {});
  renderMediaAppLists(provider);
  const statusEl = document.getElementById(provider + 'ConnectStatus');
  if (statusEl) {
    if (live) statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">✓ Connected' + (info.username ? ' as ' + escapeHtml(info.username) : '') + '</span>';
    else if (lapsed) statusEl.innerHTML = '<span class="u-c-v_color_warn_text u-fw-600">Sign in again</span>';
    else statusEl.innerHTML = '<span class="u-c-v_muted">Not connected</span>';
  }
  const connectBtn = document.getElementById(provider + 'ConnectBtn');
  if (connectBtn) {
    connectBtn.style.display = live ? 'none' : '';
    connectBtn.textContent = lapsed ? 'Reconnect ' + name : (provider === 'nuvio' ? 'Sign in to Nuvio' : 'Connect Stremio account');
  }
  const disconnectBtn = document.getElementById(provider + 'DisconnectBtn');
  if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
  const form = document.getElementById('nuvioLoginForm');
  if (form && provider === 'nuvio') form.style.display = live ? 'none' : '';
  const wrap = document.getElementById(provider + 'SyncWrap');
  if (wrap) wrap.style.display = live ? '' : 'none';
  if (!live) return;
  const sync = info.sync || {};
  const pull = document.getElementById(provider + 'PullCheckbox');
  if (pull) pull.checked = !!sync.pull;
  const push = document.getElementById(provider + 'PushCheckbox');
  if (push) push.checked = !!sync.push;
  const pushRow = document.getElementById(provider + 'PushRow');
  if (pushRow) pushRow.style.display = info.pushAvailable ? '' : 'none';
  const statusLine = document.getElementById(provider + 'SyncStatus');
  if (statusLine) statusLine.textContent = mediaAppUiSyncLine(sync);
  if (provider === 'nuvio') {
    const sel = document.getElementById('nuvioProfileSelect');
    if (sel) {
      // The profiles Nuvio named; Profile 1 to 6 only when none came back.
      let profiles = Array.isArray(info.profiles) ? info.profiles : [];
      if (!profiles.length) profiles = [1, 2, 3, 4, 5, 6].map(function (i) { return { index: i, name: 'Profile ' + i }; });
      let html = sync.profileIndex ? '' : '<option value="">Choose a profile</option>';
      for (let i = 0; i < profiles.length; i++) {
        html += '<option value="' + profiles[i].index + '"' + (sync.profileIndex === profiles[i].index ? ' selected' : '') + '>' + escapeHtml(profiles[i].name) + '</option>';
      }
      sel.innerHTML = html;
    }
  }
}

async function mediaAppUiRefresh(provider) {
  if (typeof isSignedIn === 'function' && !isSignedIn()) {
    renderMediaAppStatus(provider, null);
    return;
  }
  const r = await mediaAppUiCall(provider, 'settings', 'GET');
  renderMediaAppStatus(provider, r.ok ? r.data : null);
}

function refreshMediaAppConnections() {
  mediaAppUiRefresh('stremio');
  mediaAppUiRefresh('nuvio');
}

function stopStremioLinkPoll() {
  if (mediaAppUiPoll) clearInterval(mediaAppUiPoll);
  mediaAppUiPoll = null;
  const box = document.getElementById('stremioLinkBox');
  if (box) box.style.display = 'none';
}

// Stremio's Link service answers the browser (and not our Worker), so the page
// runs the flow and hands the finished authKey to the server once.
async function mediaAppUiStremioLink(path) {
  try {
    const res = await fetch('https://link.stremio.com/api/v2/' + path);
    return await res.json();
  } catch (e) {
    return null;
  }
}

// One check of the code. True once the server has the connection; false while
// Stremio waits for the person to approve it.
async function mediaAppUiStremioPoll(code) {
  const data = await mediaAppUiStremioLink('read?type=Read&code=' + encodeURIComponent(code));
  const key = data && data.result && data.result.authKey;
  if (!key) return false;
  const done = await mediaAppUiCall('stremio', 'link/complete', 'POST', { authKey: key });
  if (!done.ok) {
    stopStremioLinkPoll();
    showToast(mediaAppUiMessage(done, 'Could not connect Stremio. Please try again.'), 'error');
    return false;
  }
  stopStremioLinkPoll();
  showToast('Stremio connected.', 'success');
  mediaAppUiRefresh('stremio');
  return true;
}

async function startStremioConnect() {
  if (!requireSignedInFor('connect your Stremio account')) return;
  stopStremioLinkPoll();
  const started = await mediaAppUiStremioLink('create?type=Create');
  const link = started && started.result;
  if (!link || !link.code) {
    showToast('Could not reach Stremio to start the link. Please try again.', 'error');
    return;
  }
  const box = document.getElementById('stremioLinkBox');
  if (box) {
    const safeLink = typeof link.link === 'string' && link.link.indexOf('https://link.stremio.com/') === 0 ? link.link : '';
    box.innerHTML = '<p class="u-m-0 u-fs-v_font_size_sm u-c-v_text">Open <a href="' + escapeAttr(safeLink || 'https://link.stremio.com/') + '" target="_blank" rel="noopener" class="u-c-v_accent_2">link.stremio.com</a>, sign in to Stremio if asked, and enter this code:</p>' +
      '<p class="u-m-6px_0 u-fw-600">' + escapeHtml(link.code) + '</p>' +
      '<p class="u-m-0 u-fs-v_font_size_xs u-c-v_muted">Waiting for you to approve it in Stremio\u2026</p>';
    box.style.display = '';
  }
  let ticks = 0;
  mediaAppUiPoll = setInterval(async function () {
    ticks++;
    if (ticks > 200) {
      stopStremioLinkPoll();
      showToast('The Stremio link expired. Start again to get a new code.', 'error');
      return;
    }
    await mediaAppUiStremioPoll(link.code);
  }, 3000);
}

async function submitNuvioLogin() {
  if (!requireSignedInFor('connect your Nuvio account')) return;
  const emailEl = document.getElementById('nuvioEmailInput');
  const passEl = document.getElementById('nuvioPasswordInput');
  const email = emailEl ? emailEl.value.trim() : '';
  const password = passEl ? passEl.value : '';
  if (!email || !password) {
    showToast('Enter your Nuvio email and password.', 'error');
    return;
  }
  const btn = document.getElementById('nuvioConnectBtn');
  if (btn) btn.disabled = true;
  const r = await mediaAppUiCall('nuvio', 'login', 'POST', { email: email, password: password });
  if (btn) btn.disabled = false;
  if (passEl) passEl.value = '';
  if (!r.ok) {
    showToast(mediaAppUiMessage(r, 'Could not sign in to Nuvio. Please try again.'), 'error');
    return;
  }
  if (emailEl) emailEl.value = '';
  showToast(r.data.profileIndex ? 'Nuvio connected.' : 'Nuvio connected. Choose which profile to read.', 'success');
  mediaAppUiRefresh('nuvio');
}

async function setMediaAppSyncOption(provider, key, value) {
  const body = {};
  if (key === 'profileIndex') {
    if (!value) return;
    body.profileIndex = Number(value);
  } else {
    body[key] = !!value;
  }
  const r = await mediaAppUiCall(provider, 'settings', 'POST', body);
  if (!r.ok) showToast(mediaAppUiMessage(r, 'Could not save that setting. Please try again.'), 'error');
  mediaAppUiRefresh(provider);
}

// Pulls now and waits, so the answer is what the app holds.
async function syncMediaAppNow(provider, btn) {
  if (btn) btn.disabled = true;
  mediaAppUpdateTried[provider] = Date.now();
  mediaAppListsBusy[provider] = true;
  renderMediaAppLists(provider);
  if (typeof renderCollectionsMediaApps === 'function') renderCollectionsMediaApps();
  const r = await mediaAppUiCall(provider, 'sync', 'POST', { wait: true, force: true });
  mediaAppListsBusy[provider] = false;
  if (btn) btn.disabled = false;
  if (!r.ok) {
    showToast(mediaAppUiMessage(r, 'Could not sync ' + MEDIA_APP_UI_NAMES[provider] + '. Please try again.'), 'error');
  } else if (r.data.skipped === 'busy') {
    showToast(MEDIA_APP_UI_NAMES[provider] + ' is already syncing. It can take a few minutes.', 'info');
  } else {
    const last = r.data.sync && r.data.sync.lastResult;
    const line = !r.data.done ? ' is syncing. The rest will follow in a few minutes.' : ' is up to date.' + (last ? ' Found ' + last.found + (last.found === 1 ? ' title.' : ' titles.') : '');
    showToast(MEDIA_APP_UI_NAMES[provider] + line, r.data.done ? 'success' : 'info');
  }
  mediaAppUiRefresh(provider);
}

// The tile's remove button on the Nuvio and Stremio lists: removes the item in the app itself,
// then here (61_media-app-sync.js). Asks first; the tile only goes once the app has accepted.
function removeMediaAppItem(btn) {
  const provider = btn.dataset.provider;
  const target = btn.dataset.target;
  const id = btn.dataset.removeId;
  const mediaType = btn.dataset.mediaType || 'movie';
  const itemName = btn.dataset.name || 'This title';
  const app = MEDIA_APP_UI_NAMES[provider];
  if (!app || !id || (target !== 'history' && target !== 'continue-watching')) return;
  const isShow = mediaType === 'series' || mediaType === 'episode';
  const message = target === 'history'
    ? '"' + itemName + '"' + (isShow ? ' and all its watched episodes' : '') + ' will be removed from your Watch History in ' + app + ', and from ' + app + ' itself.'
    : '"' + itemName + '" will be removed from Continue Watching in ' + app + '. Your Watch History is not changed.';
  showAppConfirm('Remove from ' + app + '?', message, 'Remove', async function () {
    const r = await mediaAppUiCall(provider, 'remove', 'POST', { target: target, id: id, mediaType: mediaType });
    if (!r.ok) {
      showToast(mediaAppUiMessage(r, 'Could not remove "' + itemName + '" from ' + app + '. Please try again.'), 'error');
      return;
    }
    const card = btn.closest('.live-preview-poster-card, .list-card-mini-poster-tile');
    if (card && card.parentNode) {
      const grid = card.parentNode;
      grid.removeChild(card);
      const remaining = grid.querySelectorAll ? grid.querySelectorAll('.live-preview-poster-card').length : 0;
      if (typeof window._updateListDetailsItemCount === 'function' && document.getElementById('detailGrid') === grid) window._updateListDetailsItemCount(remaining);
    }
    // Previews of this app's lists are out of date now.
    if (window._listPreviewCache && typeof window._listPreviewCache.forEach === 'function') {
      const stale = [];
      window._listPreviewCache.forEach(function (v, k) { if (String(k).indexOf('autotrack:' + provider + '-') === 0) stale.push(k); });
      stale.forEach(function (k) { window._listPreviewCache.delete(k); });
    }
    showToast('Removed "' + itemName + '" from ' + app + '.', 'success');
  }, true);
}

function disconnectMediaApp(provider) {
  const name = MEDIA_APP_UI_NAMES[provider];
  showAppConfirm(
    'Disconnect ' + name + '?',
    'Syncing stops. What was already brought in stays in your Watch History and Continue Watching.',
    'Disconnect',
    async function () {
      stopStremioLinkPoll();
      const r = await mediaAppUiCall(provider, '', 'DELETE');
      if (!r.ok) showToast(mediaAppUiMessage(r, 'Could not disconnect ' + name + '. Please try again.'), 'error');
      else showToast(name + ' disconnected.', 'success');
      mediaAppUiRefresh(provider);
    }
  );
}

let mySimklListsTimer = null;
function scheduleMySimklListsRefresh() {
  clearTimeout(mySimklListsTimer);
  mySimklListsTimer = setTimeout(runMySimklLists, 600);
}

async function runMySimklLists() {
  const box = document.getElementById('mySimklListsResult');
  if (!box) return;
  const token = simklAccessToken || readProviderSecret('myListAddon:simklAccessToken') || '';
  const input = document.getElementById('simklKeyInput');
  const key = (input ? input.value.trim() : '') || readProviderSecret('myListAddon:simklKey') || '';

  const neutralMsg = '<p class="u-mt-10px u-c-v_muted"><small>Connect your Simkl account in Settings or click <strong>Connect Simkl</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';

  if (!token) {
    box.innerHTML = neutralMsg;
    return;
  }

  box.innerHTML = '<p class="u-mt-10px"><small>Loading your Simkl lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/simkl/my-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, simklKey: key }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (data.error && (data.error.includes('connect your Simkl account') || data.error.includes('Please connect'))) {
        box.innerHTML = neutralMsg;
      } else {
        box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Simkl lists.') + '</p>';
      }
      return;
    }
    if (data.username) {
      simklUsername = data.username;
      try {
        localStorage.setItem('myListAddon:simklUsername', simklUsername);
        localStorage.removeItem('myListAddon:simklDisconnected');
      } catch (e) {}
      renderSimklConnectStatus();
    }
    renderMySimklLists(data.lists);
  } catch (e) {
    console.error('Simkl lists load error:', e);
    box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml((e && e.message) ? e.message : 'Network error loading your Simkl lists.') + '</p>';
  }
}

let _simklAiringNextEnriching = false;
let _simklAiringNextEnrichedAt = 0;
async function enrichSimklAiringNextDates(list) {
  if (!list || !Array.isArray(list.items) || !list.items.length) return;
  const hasExpiredSimkl = (list.items || []).some((it) => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
  if (!hasExpiredSimkl && _simklAiringNextEnrichedAt && (Date.now() - _simklAiringNextEnrichedAt < 300000)) return;
  _simklAiringNextEnriching = true;

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || readProviderSecret('myListAddon:tmdbKey') || '';

  try {
    const rawCandidates = (window._simklRawAiringCandidates && window._simklRawAiringCandidates.length)
      ? window._simklRawAiringCandidates
      : (list.items || []);
    const candidates = rawCandidates.slice(0, 80);
    const enriched = [];
    const concurrency = 5;
    for (let i = 0; i < candidates.length; i += concurrency) {
      const chunk = candidates.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (it) => {
        try {
          const showId = it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '');
          if (!showId) return;
          const bypass = hasExpiredSimkl ? '&fresh=1&_t=' + Date.now() : '';
          const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(showId) + '&type=series&tmdbKey=' + encodeURIComponent(tmdbKey) + bypass);
          const data = await res.json();
          const d = data && data.ok ? data.details : null;
          // Only include shows with a real future air date (excludes ended shows with no upcoming episode)
          if (d && d.nextEpisodeAirDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(d.nextEpisodeAirDate))) {
            it.airDate = d.nextEpisodeAirDate;
            it.seasonNum = d.nextEpisodeSeasonNumber;
            it.episodeNum = d.nextEpisodeNumber;
            it.isSeasonPremiere = (typeof d.isSeasonPremiere === 'boolean') ? d.isSeasonPremiere : (d.nextEpisodeNumber === 1);
            it.isSeasonFinale = !!d.isSeasonFinale;
            it.seasonFinaleAirDate = d.seasonFinaleAirDate || null;
            it.seasonFinaleEpisodeNumber = d.seasonFinaleEpisodeNumber || null;
            it.isUnaired = true;
            it.episodeTitle = d.nextEpisodeName || (it.isSeasonPremiere ? 'Season Premiere' : (it.isSeasonFinale ? 'Season Finale' : ('Episode ' + d.nextEpisodeNumber)));
            enriched.push(it);
          }
          // Shows with no nextEpisodeAirDate are silently dropped (ended, no renewal announced)
        } catch (e) {}
      }));
    }
    if (enriched.length) {
      enriched.sort((a, b) => (a.airDate || '').localeCompare(b.airDate || ''));
      list.items = enriched;
      list.itemCount = enriched.length;
      try {
        localStorage.setItem('myListAddon:simklAiringNextCache', JSON.stringify(enriched));
      } catch (e) {}
      _simklAiringNextEnrichedAt = Date.now();
      renderMySimklLists(window._mySimklLists);
    }
  } finally {
    _simklAiringNextEnriching = false;
  }
}

function openSimklAiringNextDetailsPage() {
  const list = (window._mySimklLists || []).find((l) => l && (l.statusKey === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
  if (!list) return;
  const filtered = (list.items || []).filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
  const localAiringList = (typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
  const sample = filtered.map((it) => {
    const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
    const isPremiere = (typeof it.isSeasonPremiere === 'boolean') ? it.isSeasonPremiere : (localMatch ? localMatch.isSeasonPremiere : (it.episodeNum === 1));
    const isFinale = !!(it.isSeasonFinale || (localMatch && localMatch.isSeasonFinale));
    const finaleAirDate = it.seasonFinaleAirDate || (localMatch && localMatch.seasonFinaleAirDate) || null;

    const label = (typeof formatWatchItemLabel === 'function')
      ? formatWatchItemLabel({ showTitle: it.name, seasonNum: it.seasonNum, episodeNum: it.episodeNum, title: it.episodeTitle || '', isSeasonPremiere: isPremiere })
      : {
          title: it.name + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
          subtitle: it.episodeTitle || (isPremiere ? 'Season Premiere' : (isFinale ? 'Season Finale' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : '')))
        };
    return {
      id: it.id,
      type: 'series',
      name: label.title,
      subtitle: label.subtitle,
      poster: it.poster,
      airDate: it.airDate,
      airTime: it.airTime || '',
      showId: it.showId || it.id,
      seasonNum: it.seasonNum,
      episodeNum: it.episodeNum,
      isUnaired: true,
      isSeasonPremiere: isPremiere,
      isSeasonFinale: isFinale,
      seasonFinaleAirDate: finaleAirDate,
      removeExternalProvider: 'simkl',
      removeExternalTarget: 'status',
      removeExternalListId: it.status || 'watching',
    };
  });
  openListDetailsPage('Simkl Airing Next', 'series', 'simkl:user:shows:airing-next', { sample: sample, count: sample.length, maybeMore: false, creatorName: 'Simkl' }, { creatorName: 'Simkl' });
}

function renderMySimklLists(lists) {
  window._mySimklLists = lists || [];
  const box = document.getElementById('mySimklListsResult');
  if (!box) return;
  if (!lists || !lists.length) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>No items found on your Simkl account.</small></p>';
    return;
  }

  const airingNextList = lists.find((l) => l && (l.statusKey === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
  if (airingNextList && Array.isArray(airingNextList.items) && airingNextList.items.length) {
    if (!window._simklRawAiringCandidates || !window._simklRawAiringCandidates.length) {
      window._simklRawAiringCandidates = airingNextList.items.map(it => ({ ...it }));
    }
    const localAiringList = (typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
    if (!airingNextList._cachedApplied) {
      try {
        const cached = JSON.parse(localStorage.getItem('myListAddon:simklAiringNextCache') || '[]');
        if (Array.isArray(cached) && cached.length) {
          const cacheMap = new Map(cached.map((c) => [c.id || c.imdbId || (c.tmdbId ? 'tmdb:' + c.tmdbId : ''), c]));
          airingNextList.items.forEach((it) => {
            const c = cacheMap.get(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : ''));
            const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
            if (c) {
              it.airDate = c.airDate;
              it.seasonNum = c.seasonNum;
              it.episodeNum = c.episodeNum;
              it.isSeasonPremiere = (typeof c.isSeasonPremiere === 'boolean') ? c.isSeasonPremiere : (localMatch ? localMatch.isSeasonPremiere : (c.episodeNum === 1));
              it.isSeasonFinale = !!(c.isSeasonFinale || (localMatch && localMatch.isSeasonFinale));
              it.seasonFinaleAirDate = c.seasonFinaleAirDate || (localMatch && localMatch.seasonFinaleAirDate) || null;
              it.seasonFinaleEpisodeNumber = c.seasonFinaleEpisodeNumber || null;
              it.isUnaired = true;
              it.episodeTitle = c.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.isSeasonFinale ? 'Season Finale' : (c.episodeNum != null ? ('Episode ' + c.episodeNum) : '')));
            } else if (localMatch) {
              it.isSeasonPremiere = !!localMatch.isSeasonPremiere;
              it.isSeasonFinale = !!localMatch.isSeasonFinale;
              it.seasonFinaleAirDate = localMatch.seasonFinaleAirDate || null;
            }
          });
        } else if (localAiringList.length) {
          airingNextList.items.forEach((it) => {
            const localMatch = localAiringList.find((a) => a && (a.showId === it.id || a.showId === it.imdbId || (it.tmdbId && a.showId === 'tmdb:' + it.tmdbId)));
            if (localMatch) {
              it.isSeasonPremiere = !!localMatch.isSeasonPremiere;
              it.isSeasonFinale = !!localMatch.isSeasonFinale;
              it.seasonFinaleAirDate = localMatch.seasonFinaleAirDate || null;
            }
          });
        }
      } catch (e) {}
      airingNextList._cachedApplied = true;
    }
    const hasExpiredSimkl = (airingNextList.items || []).some((it) => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
    if (!_simklAiringNextEnriching && (hasExpiredSimkl || !_simklAiringNextEnrichedAt || Date.now() - _simklAiringNextEnrichedAt >= 120000)) {
      enrichSimklAiringNextDates(airingNextList).catch(() => {});
    }
  }

  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  window._simklListsMap = window._simklListsMap || {};
  lists.forEach(function(l) {
    if (l && l.url) window._simklListsMap[l.url] = l;
  });

  const visibleLists = (typeof isListHidden === 'function') ? lists.filter((l) => !isListHidden(l && l.url)) : lists;

  const cardsHtml = visibleLists.map((l) => {
    const type = l.type === 'series' ? 'series' : 'movie';
    const typeLabel = l.type === 'series' ? 'Shows' : 'Movies';
    const isAiringNext = l.statusKey === 'airing-next' || (l.url && l.url.includes(':airing-next'));

    let filteredItems = l.items || [];
    if (isAiringNext) {
      filteredItems = filteredItems.filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
    }

    const totalCount = isAiringNext ? filteredItems.length : (l.itemCount || (l.items || []).length);
    const added = typeof isListAddedToConfig === 'function' ? (isListAddedToConfig(l.url, type) || isListAddedToConfig(null, type, l.url)) : alreadyAdded.has(l.url + '|' + type);

    const isCompleted = (l.name && l.name.toLowerCase().includes('completed')) || (l.url && l.url.includes(':completed')) || l.statusKey === 'completed';
    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">Copy</button>';

    const markWatchedBtn = isCompleted
      ? '<button type="button" class="lc-btn secondary" data-url="' + escapeAttr(l.url) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(type) + '" data-act="markSimklListAllWatched" data-act-args="[&quot;@self&quot;]">Mark all as Watched</button>'
      : '';
    const addBtn = '<button type="button" class="lc-btn list-add-btn secondary myListAddBtn' + (added ? ' is-added' : '') + '" ' + (added ? 'style="color:var(--danger);"' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? 'Remove' : '+ Add') + '</button>';

    const previewItems = filteredItems.slice(0, 9);
    let posterThumbs = '';
    if (previewItems.length) {
      posterThumbs = '<div class="list-card-posters poster-preview-static">' +
        previewItems.map((it, i) => {
          const isMobileEnd = (i === 2 && previewItems.length > 3);
          const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
          let overlays = '';
          if (isAiringNext) {
            if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only simklAiringNextViewBtn u-cur-pointer" data-act="openSimklAiringNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';
            if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only simklAiringNextViewBtn u-cur-pointer" data-act="openSimklAiringNextDetailsPage" data-act-stop>' + totalCount + ' &rsaquo;</div>';
          } else {
            if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only searchViewListBtn u-cur-pointer" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '">' + totalCount + ' &rsaquo;</div>';
            if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only searchViewListBtn u-cur-pointer" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '">' + totalCount + ' &rsaquo;</div>';
          }
          const simklStatus = isAiringNext ? (it.status || 'watching') : (l.statusKey || (l.url ? l.url.split(':')[3] : 'plantowatch'));
          const removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="simkl" data-target="status" data-list-id="' + escapeAttr(simklStatus) + '" data-remove-id="' + escapeAttr(it.id) + '" data-media-type="' + escapeAttr(it.type || type) + '" data-act="removeListItemFromDetails" data-act-stop data-act-args="[&quot;@self&quot;]" title="Remove from Simkl" aria-label="Remove from Simkl">\u2715</button>';
          const showAiringBadges = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgesAiringNext') : true;
          const showAirDate = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true);
          const showPremiere = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true);
          const showFinale = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true);
          const showFinaleDate = showAiringBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true);

          const hasAired = it.airDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(it.airDate) : false;
          const isUnairedEp = it.airDate ? !hasAired : !!it.isUnaired;
          let dateBadge = '';
          if (showAirDate && it.airDate && !hasAired && typeof isEpisodeAired === 'function') {
            dateBadge = typeof watchItemAirDateBadgeHtml === 'function' ? watchItemAirDateBadgeHtml(it) : '';
          }
          const isSeasonPremiere = (it.episodeNum === 1 || (it.episodeNum == null && it.isSeasonPremiere));
          const isSeasonFinale = !!it.isSeasonFinale;
          const seasonFinaleAirDate = it.seasonFinaleAirDate || null;
          const isFinaleUnaired = seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(seasonFinaleAirDate) : !!seasonFinaleAirDate;
          let bottomBadge = '';
          if (isUnairedEp) {
            if (showPremiere && isSeasonPremiere) {
              bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Premiere</div>';
            } else if (showFinale && isSeasonFinale) {
              bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Finale</div>';
            } else if (showFinaleDate && seasonFinaleAirDate && isFinaleUnaired) {
              const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(it.seasonFinaleAirDate) : '';
              if (finaleText) {
                bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(it.seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
              }
            }
          }
          const label = (typeof formatWatchItemLabel === 'function')
            ? formatWatchItemLabel({ showTitle: it.name, seasonNum: it.seasonNum, episodeNum: it.episodeNum, title: it.episodeTitle || '', isSeasonPremiere: it.isSeasonPremiere })
            : {
                title: it.name + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
                subtitle: it.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : ''))
              };

          const smkPoster = typeof resolveClientPoster === 'function' ? resolveClientPoster(it, it.poster) : it.poster;
          return '<div class="list-card-mini-poster-tile" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '">' +
            '<div class="list-card-mini-poster-img-wrap">' +
              (smkPoster ? '<img src="' + escapeAttr(smkPoster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(it.type || type) + '" data-title="' + escapeAttr(it.name || '') + '" data-poster="' + escapeAttr(smkPoster || '') + '" alt="" loading="lazy">' : '<div class="u-bg-v_color_bg_sunken" style="width:100%; height:100%;"></div>') +
              (isAiringNext ? (dateBadge + bottomBadge) : '') +
              removeBtn +
              overlays +
            '</div>' +
            '<div class="list-card-mini-poster-name">' + escapeHtml(isAiringNext ? label.title : (it.name || '')) + '</div>' +
            ((isAiringNext ? label.subtitle : (it.year ? String(it.year) : '')) ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(isAiringNext ? label.subtitle : String(it.year)) + '</div>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    } else if (isAiringNext) {
      posterThumbs = '<p class="u-mt-8px u-c-v_muted"><small>Nothing scheduled yet.</small></p>';
    }

    const titleClick = isAiringNext ? 'data-act="openSimklAiringNextDetailsPage"' : '';

    return '<div class="list-card" data-list-type="' + type + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title u-cur-pointer" ' + titleClick + '>' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span><span>' + totalCount + ' items</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          markWatchedBtn +
          addBtn +
        '</div>' +
      '</div>' +
      posterThumbs +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml || '<p class="u-mt-10px u-c-v_muted"><small>All lists here are hidden. Manage visibility under Settings &rarr; Watchlist Preferences.</small></p>';
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
}

document.getElementById('mySimklListsResult')?.addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn) {
    handleMyListAddBtnClick(addBtn);
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
    return;
  }
});

function updateConnectionStatusBadges() {
  if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();
  if (typeof renderTraktConnectStatus === 'function') renderTraktConnectStatus();
  if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
  if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
}

function toggleProviderHistorySync(provider, enabled) {
  const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
  try {
    localStorage.setItem('myListAddon:sync' + cap + 'History', enabled ? 'true' : 'false');
  } catch (e) {}
  saveState();
  if (provider === 'trakt') renderTraktConnectStatus();
  if (provider === 'mdblist') renderMdblistConnectStatus();
  if (provider === 'simkl') renderSimklConnectStatus();
  if (typeof pushCreatorSync === 'function' && activeCreator) {
    pushCreatorSync();
  }
}

async function syncWatchHistoryToProviderNow(provider, btn) {
  const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
  const localMap = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  const historyList = localMap['watch-history'];
  const items = (historyList && Array.isArray(historyList.items)) ? historyList.items : [];
  
  if (!items.length) {
    if (typeof showAppAlert === 'function') showAppAlert('Empty Watch History', 'Your Watch History is currently empty.', false);
    else showToast('Your Watch History is currently empty.', 'error');
    return;
  }

  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing ' + items.length + ' items\u2026';
  }

  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || readProviderSecret('myListAddon:traktAccessToken') || '';
  const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || readProviderSecret('myListAddon:traktKey') || '';
  const mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || readProviderSecret('myListAddon:mdblistAccessToken') || '';
  const mdblistKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || readProviderSecret('myListAddon:mdblistKey') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || readProviderSecret('myListAddon:simklAccessToken') || '';
  const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || readProviderSecret('myListAddon:simklKey') || '';

  try {
    const res = await fetch(ORIGIN + '/api/external-sync/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: provider,
        items: items,
        traktAccessToken: traktToken,
        traktKey: traktKey,
        mdblistAccessToken: mdblistToken,
        mdblistKey: mdblistKey,
        simklAccessToken: simklToken,
        simklKey: simklKey,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
    if (!res.ok || !data.ok) {
      const err = data.error || 'Unknown error';
      if (typeof showAppAlert === 'function') showAppAlert(cap + ' Sync Failed', 'Failed to sync to ' + cap + ': ' + err, false);
      else showToast('Failed to sync to ' + cap + ': ' + err, 'error');
      return;
    }
    const count = data.syncedCount != null ? data.syncedCount : items.length;
    const msg = 'Successfully synced ' + count + ' item' + (count === 1 ? '' : 's') + ' to ' + cap + ' Watch History.';
    if (typeof showAppAlert === 'function') showAppAlert(cap + ' Sync Complete', msg, true);
    else showToast(msg, 'error');
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
    if (typeof showAppAlert === 'function') showAppAlert(cap + ' Sync Failed', 'Network error syncing to ' + cap + '.', false);
    else showToast('Network error syncing to ' + cap + '.', 'error');
  }
}

async function syncAllConnectedAccountsNow(btn) {
  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || readProviderSecret('myListAddon:traktAccessToken') || '';
  const mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || readProviderSecret('myListAddon:mdblistAccessToken') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || readProviderSecret('myListAddon:simklAccessToken') || '';

  const connectedProviders = [];
  if (traktToken) connectedProviders.push('trakt');
  if (mdblistToken) connectedProviders.push('mdblist');
  if (simklToken) connectedProviders.push('simkl');

  if (!connectedProviders.length) {
    const msg = 'No external accounts (Trakt, MDBList, Simkl) are connected yet. Connect them under Settings \u2192 External Accounts & API Keys.';
    if (typeof showAppAlert === 'function') showAppAlert('No Accounts Connected', msg, false);
    else showToast(msg, 'error');
    return;
  }

  for (const p of connectedProviders) {
    await syncWatchHistoryToProviderNow(p, btn);
  }
}

async function syncSingleItemToConnectedProviders(item, action) {
  if (!item) return;
  const act = action || 'add';
  const traktSync = localStorage.getItem('myListAddon:syncTraktHistory') === 'true';
  const mdblistSync = localStorage.getItem('myListAddon:syncMdblistHistory') === 'true';
  const simklSync = localStorage.getItem('myListAddon:syncSimklHistory') === 'true';

  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || readProviderSecret('myListAddon:traktAccessToken') || '';
  const traktKeyEl = document.getElementById('traktKeyInput');
  const traktKey = (traktKeyEl ? traktKeyEl.value.trim() : '') || readProviderSecret('myListAddon:traktKey') || '';
  const mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || readProviderSecret('myListAddon:mdblistAccessToken') || '';
  const mdblistKeyEl = document.getElementById('mdblistKeyInput');
  const mdblistKey = (mdblistKeyEl ? mdblistKeyEl.value.trim() : '') || readProviderSecret('myListAddon:mdblistKey') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || readProviderSecret('myListAddon:simklAccessToken') || '';
  const simklKeyEl = document.getElementById('simklKeyInput');
  const simklKey = (simklKeyEl ? simklKeyEl.value.trim() : '') || readProviderSecret('myListAddon:simklKey') || '';

  const isMovie = item.type === 'movie' || item.kind === 'movie';
  const mediaType = isMovie ? 'movie' : 'series';
  const rootId = item.showId || item.id || item.imdbId;
  const imdbId = item.showId && item.showId.startsWith('tt') ? item.showId : (item.imdbId || (String(item.id || '').startsWith('tt') ? item.id : ''));
  const seasonNum = item.seasonNum != null ? item.seasonNum : (item.season != null ? item.season : null);
  const episodeNum = item.episodeNum != null ? item.episodeNum : (item.episode != null ? item.episode : null);
  const title = item.showTitle || item.title || item.name || '';

  const promises = [];
  // Each of these mirrors a local change out to a connected provider. They
  // used to be fired and forgotten, so an expired Trakt/Simkl/MDBList token
  // meant "syncing to your connected accounts" silently stopped working and
  // nothing ever said so. The local change is the user's own action and is
  // kept either way -- this only makes the failure visible.
  const mirrorFailures = [];
  const noteMirror = (provider) => (res) => externalMutateError(res)
    .then((err) => { if (err) mirrorFailures.push(provider.toUpperCase() + ': ' + err); })
    .catch(() => {});

  if (traktSync && traktToken) {
    promises.push(
      fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'trakt',
          target: 'history',
          action: act,
          traktAccessToken: traktToken,
          traktKey: traktKey,
          id: rootId,
          imdbId: imdbId,
          tmdbId: item.tmdbId,
          mediaType: mediaType,
          season: seasonNum,
          episode: episodeNum,
          title: title,
        }),
      }).then(noteMirror('trakt')).catch(() => {})
    );
  }

  if (mdblistSync && (mdblistToken || mdblistKey)) {
    promises.push(
      fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'mdblist',
          target: 'history',
          action: act,
          mdblistAccessToken: mdblistToken,
          mdblistKey: mdblistKey,
          id: rootId,
          imdbId: imdbId,
          tmdbId: item.tmdbId,
          mediaType: mediaType,
          season: seasonNum,
          episode: episodeNum,
          title: title,
        }),
      }).then(noteMirror('mdblist')).catch(() => {})
    );
  }

  if (simklSync && simklToken) {
    promises.push(
      fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'simkl',
          target: 'history',
          action: act,
          simklAccessToken: simklToken,
          simklKey: simklKey,
          id: rootId,
          imdbId: imdbId,
          tmdbId: item.tmdbId,
          mediaType: mediaType,
          season: seasonNum,
          episode: episodeNum,
          title: title,
        }),
      }).then(noteMirror('simkl')).catch(() => {})
    );
  }

  if (promises.length) {
    await Promise.allSettled(promises);
    if (mirrorFailures.length && typeof showAppAlert === 'function') {
      showAppAlert('Not Synced To Every Account', mirrorFailures.join('\\n'), false);
    }
  }
}

// --- Collections Option: Sagas, Franchises & Stremio/Nuvio Synced Catalogs -----

const FEATURED_TMDB_COLLECTIONS = [
  { id: 86311, name: "The Avengers Collection", url: "https://www.themoviedb.org/collection/86311" },
  { id: 10, name: "Star Wars Collection", url: "https://www.themoviedb.org/collection/10" },
  { id: 1241, name: "Harry Potter Collection", url: "https://www.themoviedb.org/collection/1241" },
  { id: 119, name: "The Lord of the Rings Collection", url: "https://www.themoviedb.org/collection/119" },
  { id: 263, name: "The Dark Knight Collection", url: "https://www.themoviedb.org/collection/263" },
  { id: 645, name: "James Bond Collection", url: "https://www.themoviedb.org/collection/645" },
  { id: 558216, name: "Spider-Man (The Movie) Collection", url: "https://www.themoviedb.org/collection/558216" },
  { id: 9485, name: "Fast & Furious Collection", url: "https://www.themoviedb.org/collection/9485" },
  { id: 328, name: "Jurassic Park Collection", url: "https://www.themoviedb.org/collection/328" },
  { id: 87359, name: "Mission: Impossible Collection", url: "https://www.themoviedb.org/collection/87359" },
  { id: 8091, name: "Alien Collection", url: "https://www.themoviedb.org/collection/8091" },
  { id: 556, name: "Pixar Animation Collection", url: "https://www.themoviedb.org/collection/556" },
  { id: 2150, name: "Shrek Collection", url: "https://www.themoviedb.org/collection/2150" },
  { id: 295, name: "Pirates of the Caribbean Collection", url: "https://www.themoviedb.org/collection/295" },
  { id: 2344, name: "The Matrix Collection", url: "https://www.themoviedb.org/collection/2344" },
  { id: 645043, name: "John Wick Collection", url: "https://www.themoviedb.org/collection/645043" },
];

const CUSTOM_COLLECTIONS_STORAGE_KEY = 'myListAddon:customCollections';

function getPremadeCollections() {
  return [
    {
      id: 'col_appletv',
      name: 'Apple TV+',
      description: 'Apple TV+ Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://i.ytimg.com/vi/6sX_BfDnyrg/maxresdefault.jpg',
      lists: [
        { name: 'Apple TV+ Top 10', url: 'https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-ahmed2250-apple-tv-top-10-movies-today' },
        { name: 'Apple TV+ Top 10', url: 'https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-ahmed2250-apple-tv-top-10-tv-shows-today' },
        { name: 'Apple TV+', url: 'tmdb:chart:appletv', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-appletv' },
        { name: 'Apple TV+', url: 'tmdb:chart:appletv', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-appletv' }
      ]
    },
    {
      id: 'col_disney',
      name: 'Disney+',
      description: 'Disney+ Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://static-www.adweek.com/wp-content/uploads/2024/03/disney-logo.jpeg?w=1200',
      lists: [
        { name: 'Disney+ Top 10', url: 'https://mdblist.com/lists/andykai/disney-top-10-no-hulu', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-andykai-disney-top-10-no-hulu' },
        { name: 'Disney+ Top 10', url: 'https://mdblist.com/lists/andykai/disney-trending-no-hulu', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-andykai-disney-trending-no-hulu' },
        { name: 'Disney+', url: 'tmdb:chart:disney', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-disney' },
        { name: 'Disney+', url: 'tmdb:chart:disney', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-disney' }
      ]
    },
    {
      id: 'col_hbomax',
      name: 'HBO Max',
      description: 'HBO Max Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTRInZVxLCd8CpYk_A80vU10wjypKNN_b1JUmTdhDj19ZlVJ2Ecz3nauXpN&s=10',
      lists: [
        { name: 'HBO Max Top 10', url: 'https://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-harmes7-hbo-max-top-10-movies-m77r6mc20q' },
        { name: 'HBO Max Top 10', url: 'https://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-harmes7-hbo-max-top-10-series-cp45l27nhd' },
        { name: 'HBO Max', url: 'tmdb:chart:hbomax', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-hbomax' },
        { name: 'HBO Max', url: 'tmdb:chart:hbomax', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-hbomax' }
      ]
    },
    {
      id: 'col_hulu',
      name: 'Hulu',
      description: 'Hulu Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://www.thisishulu.com/app/uploads/2023/10/logo-gradient-3up.svg',
      lists: [
        { name: 'Hulu Top 10', url: 'https://mdblist.com/lists/hulupiv/hulu-top-10-movies', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-hulupiv-hulu-top-10-movies' },
        { name: 'Hulu Top 10', url: 'https://mdblist.com/lists/hulupiv/hulu-top-10-shows', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-hulupiv-hulu-top-10-shows' },
        { name: 'Hulu', url: 'tmdb:chart:hulu', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-hulu' },
        { name: 'Hulu', url: 'tmdb:chart:hulu', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-hulu' }
      ]
    },
    {
      id: 'col_netflix',
      name: 'Netflix',
      description: 'Netflix Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://m.media-amazon.com/images/I/616QXs8yg0L.png',
      lists: [
        { name: 'Netflix Top 10', url: 'https://mdblist.com/lists/hdlists/netflix-top-10-trending-movies', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-hdlists-netflix-top-10-trending-movies' },
        { name: 'Netflix Top 10', url: 'https://mdblist.com/lists/hdlists/netflix-top-10-trending-shows', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-hdlists-netflix-top-10-trending-shows' },
        { name: 'Netflix', url: 'tmdb:chart:netflix', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-netflix' },
        { name: 'Netflix', url: 'tmdb:chart:netflix', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-netflix' }
      ]
    },
    {
      id: 'col_netflixkids',
      name: 'Netflix Kids',
      description: 'Netflix Kids movies and shows catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://static1.squarespace.com/static/545ad6c5e4b09bbf6a29c5ee/t/5e69c67b1ce5f056432139df/1583990409924/Netflix.jpg?format=1500w',
      lists: [
        { name: 'Netflix Kids', url: 'tmdb:chart:netflixkids', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-netflixkids' },
        { name: 'Netflix Kids', url: 'tmdb:chart:netflixkids', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-netflixkids' }
      ]
    },
    {
      id: 'col_paramount',
      name: 'Paramount+',
      description: 'Paramount+ Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://cdn.mos.cms.futurecdn.net/UFo74BuGo7FYxhAE3DrWUP.jpg',
      lists: [
        { name: 'Paramount+ Top 10', url: 'https://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-ahmed2250-paramount-top-10-movies-today' },
        { name: 'Paramount+ Top 10', url: 'https://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-ahmed2250-paramount-top-10-tv-shows-today' },
        { name: 'Paramount+', url: 'tmdb:chart:paramount', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-paramount' },
        { name: 'Paramount+', url: 'tmdb:chart:paramount', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-paramount' }
      ]
    },
    {
      id: 'col_primevideo',
      name: 'Prime Video',
      description: 'Prime Video Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://oyster.ignimgs.com/mediawiki/apis.ign.com/prime-video/3/3b/Primevideo-seo-logo_s586.png',
      lists: [
        { name: 'Prime Video Top 10', url: 'https://mdblist.com/lists/diimaan/amazon-prime-top-10-movies', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-diimaan-amazon-prime-top-10-movies' },
        { name: 'Prime Video Top 10', url: 'https://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-diimaan-amazon-prime-top-10-tv-shows' },
        { name: 'Prime Video', url: 'tmdb:chart:primevideo', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-primevideo' },
        { name: 'Prime Video', url: 'tmdb:chart:primevideo', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-primevideo' }
      ]
    },
    {
      id: 'col_peacock',
      name: 'Peacock',
      description: 'Peacock Top 10 and full streaming catalog',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://www.newscaststudio.com/wp-content/uploads/2026/05/original-peacock-logo.jpg',
      lists: [
        { name: 'Peacock Top 10', url: 'https://mdblist.com/lists/diimaan/peacock-top-10-movies', type: 'movie', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-diimaan-peacock-top-10-movies' },
        { name: 'Peacock Top 10', url: 'https://mdblist.com/lists/peacockpiv/peacock-top-10-shows', type: 'series', addonId: 'app.my-list', catalogId: 'https-mdblist-com-lists-peacockpiv-peacock-top-10-shows' },
        { name: 'Peacock', url: 'tmdb:chart:peacock', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-peacock' },
        { name: 'Peacock', url: 'tmdb:chart:peacock', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-peacock' }
      ]
    },
    {
      id: 'col_kids',
      name: 'Kids',
      description: 'Rated G, PG, PG-13 & Under and Netflix Kids',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: 'https://t3.ftcdn.net/jpg/01/83/26/74/360_F_183267411_05WWsOOcByAaAjnfzklSLS530axmLTJB.jpg',
      lists: [
        { name: 'Rated G & Under', url: 'tmdb:kids:g', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-kids-g' },
        { name: 'Rated G & Under', url: 'tmdb:kids:g', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-kids-g' },
        { name: 'Rated PG & Under', url: 'tmdb:kids:pg', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-kids-pg' },
        { name: 'Rated PG & Under', url: 'tmdb:kids:pg', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-kids-pg' },
        { name: 'Rated PG-13 & Under', url: 'tmdb:kids:pg13', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-kids-pg13' },
        { name: 'Rated PG-13 & Under', url: 'tmdb:kids:pg13', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-kids-pg13' },
        { name: 'Netflix Kids', url: 'tmdb:chart:netflixkids', type: 'movie', addonId: 'app.my-list', catalogId: 'tmdb-chart-netflixkids' },
        { name: 'Netflix Kids', url: 'tmdb:chart:netflixkids', type: 'series', addonId: 'app.my-list', catalogId: 'tmdb-chart-netflixkids' }
      ]
    }
  ];
}

function loadCustomCollections() {
  try {
    const raw = localStorage.getItem(CUSTOM_COLLECTIONS_STORAGE_KEY);
    if (!raw) {
      const premade = getPremadeCollections();
      saveCustomCollections(premade);
      return premade;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const premade = getPremadeCollections();
    const premadeMap = {};
    premade.forEach(function (p) { premadeMap[p.id] = p.coverImageUrl; });
    let updated = false;
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item) continue;
      if (item.id === 'col_hbomax') {
        const hboImg = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTRInZVxLCd8CpYk_A80vU10wjypKNN_b1JUmTdhDj19ZlVJ2Ecz3nauXpN&s=10';
        if (item.coverImageUrl !== hboImg) {
          item.coverImageUrl = hboImg;
          updated = true;
        }
      } else if (item.id && premadeMap[item.id] && (!item.coverImageUrl || item.coverImageUrl.indexOf('assets.nflxext.com') !== -1 || item.coverImageUrl.indexOf('images.ctfassets.net') !== -1 || item.coverImageUrl.indexOf('kXfqcdQKsToO0OUXHcrrNCHDBzO') !== -1 || (item.id === 'col_peacock' && item.coverImageUrl.indexOf('tmdb.org') !== -1))) {
        item.coverImageUrl = premadeMap[item.id];
        updated = true;
      }
      if (Array.isArray(item.lists)) {
        for (let j = 0; j < item.lists.length; j++) {
          const l = item.lists[j];
          if (l && l.name) {
            const clean = l.name.replace(/\s*\((?:movies|shows|series)\)\s*$/i, '').trim();
            if (clean && clean !== l.name) {
              l.name = clean;
              updated = true;
            }
          }
        }
      }
    }
    if (updated) saveCustomCollections(parsed);
    return parsed;
  } catch (e) {
    return [];
  }
}

function saveCustomCollections(collections) {
  try {
    localStorage.setItem(CUSTOM_COLLECTIONS_STORAGE_KEY, JSON.stringify(collections || []));
  } catch (e) {}
}

function loadPremadeCollectionsBtn() {
  const current = loadCustomCollections();
  const premade = getPremadeCollections();
  if (!current.length) {
    saveCustomCollections(premade);
    renderCustomCollections();
    renderPremadeCollections();
    showToast('Loaded ' + premade.length + ' premade collections.', 'success');
    return;
  }
  if (typeof showAppConfirm === 'function') {
    showAppConfirm(
      'Replace collections?',
      'Replace your collection folders with the 10 premade collections (Apple TV+, Disney+, HBO Max, Hulu, Netflix, Netflix Kids, Paramount+, Prime Video, Peacock, Kids)? Click Replace to overwrite, or Cancel to keep your folders.',
      'Replace',
      function () {
        saveCustomCollections(premade);
        renderCustomCollections();
        renderPremadeCollections();
        showToast('Replaced with ' + premade.length + ' premade collections.', 'success');
      }
    );
  } else {
    addAllPremadeCollections();
  }
}

window._collectionDraft = { id: null, name: '', description: '', lists: [] };
window._expandedCollectionFolders = new Set();

function openCreateCollectionModal(editId) {
  const modal = document.getElementById('createCollectionModal');
  if (!modal) return;

  const existingCollections = loadCustomCollections();
  const existing = editId ? existingCollections.find(function (c) { return c.id === editId; }) : null;

  if (existing) {
    window._collectionDraft = {
      id: existing.id,
      name: existing.name || '',
      description: existing.description || '',
      tileShape: existing.tileShape || 'LANDSCAPE',
      hideTitle: !!existing.hideTitle,
      addonId: existing.addonId || 'app.my-list',
      coverImageUrl: existing.coverImageUrl || '',
      lists: Array.isArray(existing.lists) ? JSON.parse(JSON.stringify(existing.lists)) : []
    };
    const titleEl = document.getElementById('createCollectionModalTitle');
    if (titleEl) titleEl.textContent = 'Edit Collection';
    const btnEl = document.getElementById('createCollectionModalBtn');
    if (btnEl) btnEl.textContent = 'Save Changes';
  } else {
    window._collectionDraft = {
      id: 'col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: '',
      description: '',
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      addonId: 'app.my-list',
      coverImageUrl: '',
      lists: []
    };
    const titleEl = document.getElementById('createCollectionModalTitle');
    if (titleEl) titleEl.textContent = 'Create Collection';
    const btnEl = document.getElementById('createCollectionModalBtn');
    if (btnEl) btnEl.textContent = 'Create Collection';
  }

  const nameInput = document.getElementById('createCollectionModalName');
  if (nameInput) nameInput.value = window._collectionDraft.name;
  const descInput = document.getElementById('createCollectionModalDesc');
  if (descInput) descInput.value = window._collectionDraft.description;
  const addonInput = document.getElementById('createCollectionAddonId');
  if (addonInput) addonInput.value = window._collectionDraft.addonId || 'app.my-list';
  const coverInput = document.getElementById('createCollectionCoverImageUrl');
  if (coverInput) coverInput.value = window._collectionDraft.coverImageUrl || '';
  const tileShapeInput = document.getElementById('createCollectionTileShape');
  if (tileShapeInput) tileShapeInput.value = window._collectionDraft.tileShape || 'LANDSCAPE';
  const hideTitleInput = document.getElementById('createCollectionHideTitle');
  if (hideTitleInput) hideTitleInput.checked = !!window._collectionDraft.hideTitle;
  const urlInput = document.getElementById('createCollectionCustomListUrl');
  if (urlInput) urlInput.value = '';

  populateCollectionListPicker();
  renderCollectionDraftLists();
  validateCollectionModal();

  modal.style.display = 'flex';
  if (typeof lockBackgroundScroll === 'function') lockBackgroundScroll(true);
  if (nameInput) nameInput.focus();
}

function closeCreateCollectionModal() {
  const modal = document.getElementById('createCollectionModal');
  if (!modal) return;
  modal.style.display = 'none';
  if (typeof lockBackgroundScroll === 'function') lockBackgroundScroll(false);
}

function getAllWebsiteListsGrouped() {
  const groups = {};

  function addToList(groupName, name, url, type) {
    if (!name || !url) return;
    if (!groups[groupName]) groups[groupName] = [];
    if (!groups[groupName].some(function (item) { return item.name === name && item.url === url && item.type === type; })) {
      groups[groupName].push({ name: name, url: url, type: type || 'movie' });
    }
  }

  // 1. Configured Catalogs
  const entries = (typeof collectEntries === 'function') ? collectEntries() : [];
  if (entries.length) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e && e.name && e.url) {
        addToList('Your Catalogs', e.name, e.url, e.type || 'movie');
      }
    }
  }

  // 2. Custom Lists
  const localCustom = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  const customSlugs = Object.keys(localCustom);
  if (customSlugs.length) {
    for (let i = 0; i < customSlugs.length; i++) {
      const slug = customSlugs[i];
      const cl = localCustom[slug];
      if (cl && cl.name) {
        const url = 'customlist:v1:' + JSON.stringify({ listId: cl.listId || slug, type: cl.type || 'movie', items: cl.items || [] });
        addToList('Your Custom Lists', cl.name, url, cl.type || 'movie');
      }
    }
  }

  // 3. Curated Recommendations
  if (typeof CURATED_LIST_ENTRIES !== 'undefined' && Array.isArray(CURATED_LIST_ENTRIES)) {
    for (let i = 0; i < CURATED_LIST_ENTRIES.length; i++) {
      const c = CURATED_LIST_ENTRIES[i];
      if (c && c.name && c.slug) {
        addToList('Curated Recommendations', c.name, 'custom:curated:' + c.slug, c.type || 'movie');
      }
    }
  }

  // 4. Connected App Lists (Stremio & Nuvio)
  const providers = ['stremio', 'nuvio'];
  for (let p = 0; p < providers.length; p++) {
    const prov = providers[p];
    const provName = (typeof MEDIA_APP_UI_NAMES !== 'undefined' && MEDIA_APP_UI_NAMES[prov]) || (prov === 'stremio' ? 'Stremio' : 'Nuvio');
    if (typeof mediaAppListsLive !== 'undefined' && mediaAppListsLive[prov]) {
      if (typeof MEDIA_APP_LISTS !== 'undefined' && Array.isArray(MEDIA_APP_LISTS)) {
        for (let m = 0; m < MEDIA_APP_LISTS.length; m++) {
          const l = MEDIA_APP_LISTS[m];
          if (typeof mediaAppListUrls === 'function') {
            const urls = mediaAppListUrls(prov, l.slug);
            if (urls) {
              addToList('Connected Apps (' + provName + ')', provName + ' ' + l.title + ' (Movies)', urls.movie, 'movie');
              addToList('Connected Apps (' + provName + ')', provName + ' ' + l.title + ' (Shows)', urls.series, 'series');
            }
          }
        }
      }
    }
  }

  // 5. Official Charts & Provider Lists (CHART_SLUG_ENTRIES)
  if (typeof CHART_SLUG_ENTRIES !== 'undefined' && Array.isArray(CHART_SLUG_ENTRIES)) {
    for (let i = 0; i < CHART_SLUG_ENTRIES.length; i++) {
      const e = CHART_SLUG_ENTRIES[i];
      if (!e || !e.name) continue;

      let groupName = 'Official Charts';
      const n = e.name;
      const mUrl = e.movieUrl || e.url || '';
      const sUrl = e.showUrl || e.url || '';

      if (n.indexOf('Most Watched') !== -1 || n === 'New on Streaming') {
        groupName = 'My Lists Addon Charts';
      } else if (n === 'Popular' || n === 'Trending' || n.indexOf('All Services') !== -1) {
        groupName = 'Combined Charts';
      } else if (n.indexOf('TMDB') !== -1 || n === 'New Releases') {
        groupName = 'TMDB Official Charts';
      } else if (n.indexOf('Trakt') !== -1) {
        groupName = 'Trakt Official Charts';
      } else if (n.indexOf('MDBList') !== -1 || n.indexOf('MovieMeter') !== -1 || n.indexOf('Streaming Charts') !== -1) {
        groupName = 'MDBList Official Charts';
      } else if (n.indexOf('Simkl') !== -1) {
        groupName = 'Simkl Charts';
      } else if (mUrl.indexOf('top-10') !== -1 || sUrl.indexOf('top-10') !== -1) {
        groupName = 'Streaming Top 10';
      } else if (mUrl.indexOf('tmdb:chart:') !== -1) {
        groupName = 'Streaming Catalogs';
      } else if (mUrl.indexOf('tmdb:genre:') !== -1) {
        groupName = 'Genre Catalogs';
      } else if (mUrl.indexOf('tmdb:kids:') !== -1) {
        groupName = 'Kids & Family';
      } else if (mUrl.indexOf('tmdb:holiday:') !== -1) {
        groupName = 'Holiday Specials';
      } else if (n.indexOf('Hidden Gems') !== -1) {
        groupName = 'Curated Recommendations';
      }

      if (mUrl && sUrl && mUrl !== sUrl) {
        addToList(groupName, n + ' (Movies)', mUrl, 'movie');
        addToList(groupName, n + ' (Shows)', sUrl, 'series');
      } else if (mUrl && sUrl && mUrl === sUrl) {
        if (mUrl.indexOf('movie') !== -1) {
          addToList(groupName, n, mUrl, 'movie');
        } else if (mUrl.indexOf('show') !== -1 || mUrl.indexOf('series') !== -1 || mUrl.indexOf('anime') !== -1) {
          addToList(groupName, n, sUrl, 'series');
        } else {
          addToList(groupName, n + ' (Movies)', mUrl, 'movie');
          addToList(groupName, n + ' (Shows)', sUrl, 'series');
        }
      } else if (mUrl) {
        addToList(groupName, n, mUrl, 'movie');
      } else if (sUrl) {
        addToList(groupName, n, sUrl, 'series');
      }
    }
  }

  return groups;
}

function populateCollectionListPicker() {
  const sel = document.getElementById('createCollectionListPicker');
  if (!sel) return;
  let html = '<option value="">-- Pick from website lists --</option>';

  const grouped = getAllWebsiteListsGrouped();
  const groupOrder = [
    'Your Catalogs',
    'Your Custom Lists',
    'Curated Recommendations',
    'My Lists Addon Charts',
    'Combined Charts',
    'TMDB Official Charts',
    'Trakt Official Charts',
    'MDBList Official Charts',
    'Simkl Charts',
    'Streaming Top 10',
    'Streaming Catalogs',
    'Genre Catalogs',
    'Kids & Family',
    'Holiday Specials',
    'Connected Apps (Stremio)',
    'Connected Apps (Nuvio)'
  ];

  const renderedGroups = new Set();
  for (let g = 0; g < groupOrder.length; g++) {
    const gName = groupOrder[g];
    if (grouped[gName] && grouped[gName].length) {
      renderedGroups.add(gName);
      html += '<optgroup label="' + escapeAttr(gName) + '">';
      for (let i = 0; i < grouped[gName].length; i++) {
        const item = grouped[gName][i];
        html += '<option value="' + escapeAttr(JSON.stringify(item)) + '">' + escapeHtml(item.name) + '</option>';
      }
      html += '</optgroup>';
    }
  }

  const allGroupNames = Object.keys(grouped);
  for (let k = 0; k < allGroupNames.length; k++) {
    const gName = allGroupNames[k];
    if (!renderedGroups.has(gName) && grouped[gName].length) {
      html += '<optgroup label="' + escapeAttr(gName) + '">';
      for (let i = 0; i < grouped[gName].length; i++) {
        const item = grouped[gName][i];
        html += '<option value="' + escapeAttr(JSON.stringify(item)) + '">' + escapeHtml(item.name) + '</option>';
      }
      html += '</optgroup>';
    }
  }

  sel.innerHTML = html;
}

function addPickerListToCollectionDraft() {
  const sel = document.getElementById('createCollectionListPicker');
  if (!sel || !sel.value) return;
  try {
    const item = JSON.parse(sel.value);
    if (!item || !item.url) return;
    if (!window._collectionDraft.lists) window._collectionDraft.lists = [];
    const exists = window._collectionDraft.lists.some(function (l) { return l.url === item.url; });
    if (exists) {
      showToast('This list is already in the collection.', 'info');
      return;
    }
    window._collectionDraft.lists.push(item);
    renderCollectionDraftLists();
    validateCollectionModal();
  } catch (e) {}
}

function addUrlListToCollectionDraft() {
  const input = document.getElementById('createCollectionCustomListUrl');
  if (!input) return;
  const rawUrl = input.value.trim();
  if (!rawUrl) {
    showToast('Enter a list URL first.', 'error');
    return;
  }
  const name = (typeof guessNameFromUrl === 'function' ? guessNameFromUrl(rawUrl) : '') || 'Imported List';
  const type = (rawUrl.indexOf('series') !== -1 || rawUrl.indexOf('shows') !== -1) ? 'series' : 'movie';
  if (!window._collectionDraft.lists) window._collectionDraft.lists = [];
  const exists = window._collectionDraft.lists.some(function (l) { return l.url === rawUrl; });
  if (exists) {
    showToast('This list is already in the collection.', 'info');
    return;
  }
  window._collectionDraft.lists.push({ name: name, url: rawUrl, type: type });
  input.value = '';
  renderCollectionDraftLists();
  validateCollectionModal();
}

function removeListFromCollectionDraft(index) {
  if (!window._collectionDraft || !window._collectionDraft.lists) return;
  window._collectionDraft.lists.splice(index, 1);
  renderCollectionDraftLists();
  validateCollectionModal();
}

function renderCollectionDraftLists() {
  const container = document.getElementById('collectionDraftListsContainer');
  const countEl = document.getElementById('collectionDraftCount');
  if (!container) return;
  const lists = (window._collectionDraft && window._collectionDraft.lists) || [];
  if (countEl) countEl.textContent = String(lists.length);

  if (!lists.length) {
    container.innerHTML = '<p class="u-m-0 u-c-v_muted u-fs-v_font_size_xs">No lists added to this collection folder yet.</p>';
    return;
  }

  container.innerHTML = lists.map(function (item, idx) {
    return '<div class="u-ai-center u-jc-space_between u-gap-8px u-p-4px_8px u-mb-4px u-br-v_radius_xs u-bg-v_surface u-bd-1px_solid_v_border" style="display:flex;">' +
      '<div class="u-minw-0 u-flex-1">' +
        '<div class="u-fw-600 u-fs-v_font_size_xs u-c-v_text u-to-ellipsis u-ws-nowrap u-ov-hidden">' + escapeHtml(item.name || 'Unnamed List') + '</div>' +
        '<div class="u-fs-v_font_size_xxs u-c-v_muted u-to-ellipsis u-ws-nowrap u-ov-hidden">' + escapeHtml(item.url || '') + '</div>' +
      '</div>' +
      '<button type="button" class="lc-btn btn-ghost u-p-2px_6px u-fs-v_font_size_xs" aria-label="Remove ' + escapeAttr(item.name) + '" data-act="removeListFromCollectionDraft" data-act-args="' + appActArgs([idx]) + '">&#x2715;</button>' +
    '</div>';
  }).join('');
}

function validateCollectionModal() {
  const nameInput = document.getElementById('createCollectionModalName');
  const btn = document.getElementById('createCollectionModalBtn');
  if (!btn) return;
  const name = nameInput ? nameInput.value.trim() : '';
  const valid = !!name;
  btn.disabled = !valid;
  btn.style.opacity = valid ? '1' : '0.5';
}

function submitCreateCollectionModal() {
  const nameInput = document.getElementById('createCollectionModalName');
  const descInput = document.getElementById('createCollectionModalDesc');
  const coverInput = document.getElementById('createCollectionCoverImageUrl');
  const tileShapeInput = document.getElementById('createCollectionTileShape');
  const hideTitleInput = document.getElementById('createCollectionHideTitle');

  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    showToast('Name this collection first.', 'error');
    return;
  }
  const desc = descInput ? descInput.value.trim() : '';
  const addonInput = document.getElementById('createCollectionAddonId');
  const addonId = (addonInput ? addonInput.value.trim() : '') || 'app.my-list';
  const coverImageUrl = coverInput ? coverInput.value.trim() : '';
  const tileShape = tileShapeInput ? tileShapeInput.value : 'LANDSCAPE';
  const hideTitle = hideTitleInput ? hideTitleInput.checked : false;

  const collections = loadCustomCollections();
  const id = window._collectionDraft.id || ('col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

  const existingIdx = collections.findIndex(function (c) { return c.id === id; });
  const entry = {
    id: id,
    name: name,
    description: desc,
    addonId: addonId,
    tileShape: tileShape,
    hideTitle: hideTitle,
    coverImageUrl: coverImageUrl,
    lists: window._collectionDraft.lists || [],
    updatedAt: Date.now()
  };

  if (existingIdx !== -1) {
    collections[existingIdx] = entry;
  } else {
    entry.createdAt = Date.now();
    collections.unshift(entry);
  }

  saveCustomCollections(collections);
  closeCreateCollectionModal();
  showToast('Collection "' + name + '" saved.', 'success');
  renderCustomCollections();
}

function renderCustomCollections() {
  const box = document.getElementById('myCustomCollectionsResult');
  if (!box) return;
  const collections = loadCustomCollections();

  if (!collections.length) {
    box.innerHTML = '<div class="u-p-16px u-ta-center u-bg-v_surface_2_rgba_255_255_255_0_04 u-br-v_radius_sm u-bd-1px_solid_v_border">' +
      '<p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">No collection folders created yet. Create folders with multiple lists inside to easily manage and install them together in Stremio and Nuvio.</p>' +
      '<button type="button" class="primary lc-btn" data-act="openCreateCollectionModal">+ Create Your First Collection</button>' +
    '</div>';
    return;
  }

  box.innerHTML = collections.map(function (col) {
    const listCount = (col.lists && col.lists.length) || 0;
    const isExpanded = window._expandedCollectionFolders && window._expandedCollectionFolders.has(col.id);

    const nl = String.fromCharCode(10);
    const movieUrls = (col.lists || []).filter(function (l) { return l.type !== 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
    const seriesUrls = (col.lists || []).filter(function (l) { return l.type === 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
    const primaryUrl = movieUrls.length ? movieUrls.join(nl) : (col.lists || []).map(function (l) { return l.url; }).join(nl);
    const primaryType = seriesUrls.length && !movieUrls.length ? 'series' : 'movie';
    const isAdded = !!primaryUrl && typeof isListAddedToConfig === 'function' && isListAddedToConfig(primaryUrl, primaryType);

    let listsPreviewHtml = '';
    if (listCount > 0) {
      listsPreviewHtml = '<div class="u-mt-10px u-pt-10px u-bdt-1px_solid_v_border"' + (isExpanded ? '' : ' style="display:none;"') + ' id="colFolderContent_' + escapeAttr(col.id) + '">' +
        '<div class="u-fs-v_font_size_xs u-fw-600 u-c-v_muted u-mb-8px u-tt-uppercase">Lists inside this folder:</div>' +
        col.lists.map(function (l, lidx) {
          const lType = l.type || 'movie';
          const listName = l.name || 'Unnamed List';
          return '<div class="list-card u-mb-8px" data-url="' + escapeAttr(l.url || '') + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-body">' +
                '<div class="u-ai-center u-gap-8px" style="display:flex; flex-wrap:wrap;">' +
                  '<span class="list-card-title">' + escapeHtml(listName) + '</span>' +
                  '<span class="u-fs-v_font_size_xxs u-p-2px_6px u-br-v_radius_pill u-bg-v_surface u-c-v_muted u-bd-1px_solid_v_border">' + escapeHtml(lType) + '</span>' +
                '</div>' +
                '<div class="list-card-meta">' +
                  '<span class="u-fs-v_font_size_xs u-c-v_muted">' + escapeHtml(l.url || '') + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="list-card-actions">' +
                '<button type="button" class="lc-btn btn-ghost u-p-4px_8px u-fs-v_font_size_xs" title="Remove from collection" aria-label="Remove ' + escapeAttr(listName) + '" data-act="removeListFromSavedCollection" data-act-args="' + appActArgs([col.id, lidx]) + '">&#x2715;</button>' +
              '</div>' +
            '</div>' +
            '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(l.url || '') + '" data-type="' + escapeAttr(lType) + '"></div>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    const shapeLabel = col.tileShape || 'LANDSCAPE';
    const hasCover = !!col.coverImageUrl;
    const coverHtml = hasCover
      ? '<img src="' + escapeAttr(col.coverImageUrl) + '" alt="' + escapeAttr(col.name) + '" style="width:100px; height:56px; object-fit:cover; border-radius:var(--radius-xs); border:1px solid var(--border); flex-shrink:0;">'
      : '';

    return '<div class="list-card" data-collection-id="' + escapeAttr(col.id) + '" style="flex-direction:column; align-items:stretch;">' +
      '<div class="list-card-header">' +
        (coverHtml ? '<div class="u-mr-10px">' + coverHtml + '</div>' : '') +
        '<div class="list-card-body">' +
          '<div class="u-ai-center u-gap-8px u-mb-4px" style="display:flex; flex-wrap:wrap;">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px; height:18px; color:var(--accent); flex-shrink:0;" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>' +
            '<span class="list-card-title u-cur-pointer" data-act="toggleCustomCollectionFolder" data-act-args="' + appActArgs([col.id]) + '">' + escapeHtml(col.name) + '</span>' +
            '<span class="u-fs-v_font_size_xs u-p-2px_8px u-br-v_radius_pill u-bg-v_surface_2_rgba_255_255_255_0_04 u-c-v_muted u-bd-1px_solid_v_border">' + listCount + (listCount === 1 ? ' list' : ' lists') + '</span>' +
            '<span class="u-fs-v_font_size_xxs u-p-2px_6px u-br-v_radius_pill u-bg-v_surface u-c-v_muted u-bd-1px_solid_v_border">' + escapeHtml(shapeLabel) + '</span>' +
            '<span class="u-fs-v_font_size_xxs u-p-2px_6px u-br-v_radius_pill u-bg-v_surface u-c-v_muted u-bd-1px_solid_v_border" title="Target Add-on ID in Nuvio">Addon: ' + escapeHtml(col.addonId || 'app.my-list') + '</span>' +
          '</div>' +
          (col.description ? '<div class="list-card-meta"><span>' + escapeHtml(col.description) + '</span></div>' : '') +
        '</div>' +
        '<div class="list-card-actions u-ai-center u-gap-6px" style="display:flex; flex-wrap:wrap;">' +
          '<button type="button" class="lc-btn list-add-btn secondary' + (isAdded ? ' is-added' : '') + '"' + (isAdded ? ' style="color:var(--danger);"' : '') +
            ' data-act="toggleCustomCollectionCatalog" data-act-args="' + appActArgs([col.id, isAdded]) + '" title="Add or remove this folder from your Stremio &amp; Addon catalogs">' + (isAdded ? 'Remove' : '+ Add to Catalogs') + '</button>' +
          '<button type="button" class="lc-btn secondary" data-act="pushSingleCollectionToNuvio" data-act-args="' + appActArgs([col.id]) + '" title="Push this folder to your connected Nuvio account">Push to Nuvio</button>' +
          '<button type="button" class="lc-btn secondary" data-act="toggleCustomCollectionFolder" data-act-args="' + appActArgs([col.id]) + '">' + (isExpanded ? 'Hide Lists' : 'View Lists') + '</button>' +
          '<button type="button" class="lc-btn secondary" data-act="openCreateCollectionModal" data-act-args="' + appActArgs([col.id]) + '">Edit</button>' +
          '<button type="button" class="lc-btn btn-danger secondary" data-act="deleteCustomCollection" data-act-args="' + appActArgs([col.id]) + '">Delete</button>' +
        '</div>' +
      '</div>' +
      listsPreviewHtml +
    '</div>';
  }).join('');

  if (typeof populateSearchResultPosters === 'function') {
    setTimeout(populateSearchResultPosters, 0);
  }
}

function toggleCustomCollectionFolder(id) {
  if (!window._expandedCollectionFolders) window._expandedCollectionFolders = new Set();
  if (window._expandedCollectionFolders.has(id)) {
    window._expandedCollectionFolders.delete(id);
  } else {
    window._expandedCollectionFolders.add(id);
  }
  renderCustomCollections();
  if (typeof populateSearchResultPosters === 'function') {
    setTimeout(populateSearchResultPosters, 0);
  }
}

function renderPremadeCollections() {
  const box = document.getElementById('premadeCollectionsResult');
  if (!box) return;
  const premade = getPremadeCollections();
  const custom = loadCustomCollections();
  const customNames = new Set(custom.map(function (c) { return (c.name || '').toLowerCase(); }));

  box.innerHTML = premade.map(function (col) {
    const listCount = (col.lists && col.lists.length) || 0;
    const isExpanded = window._expandedPremadeFolders && window._expandedPremadeFolders.has(col.id);
    const inFolders = customNames.has((col.name || '').toLowerCase());

    const nl = String.fromCharCode(10);
    const movieUrls = (col.lists || []).filter(function (l) { return l.type !== 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
    const seriesUrls = (col.lists || []).filter(function (l) { return l.type === 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
    const primaryUrl = movieUrls.length ? movieUrls.join(nl) : (col.lists || []).map(function (l) { return l.url; }).join(nl);
    const primaryType = seriesUrls.length && !movieUrls.length ? 'series' : 'movie';
    const isAdded = !!primaryUrl && typeof isListAddedToConfig === 'function' && isListAddedToConfig(primaryUrl, primaryType);

    let listsPreviewHtml = '';
    if (listCount > 0) {
      listsPreviewHtml = '<div class="u-mt-10px u-pt-10px u-bdt-1px_solid_v_border"' + (isExpanded ? '' : ' style="display:none;"') + ' id="premadeFolderContent_' + escapeAttr(col.id) + '">' +
        '<div class="u-fs-v_font_size_xs u-fw-600 u-c-v_muted u-mb-8px u-tt-uppercase">Lists inside this folder:</div>' +
        col.lists.map(function (l) {
          const lType = l.type || 'movie';
          const listName = l.name || 'Unnamed List';
          return '<div class="list-card u-mb-8px" data-url="' + escapeAttr(l.url || '') + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-body">' +
                '<div class="u-ai-center u-gap-8px" style="display:flex; flex-wrap:wrap;">' +
                  '<span class="list-card-title">' + escapeHtml(listName) + '</span>' +
                  '<span class="u-fs-v_font_size_xxs u-p-2px_6px u-br-v_radius_pill u-bg-v_surface u-c-v_muted u-bd-1px_solid_v_border">' + escapeHtml(lType) + '</span>' +
                '</div>' +
                '<div class="list-card-meta">' +
                  '<span class="u-fs-v_font_size_xs u-c-v_muted">' + escapeHtml(l.url || '') + '</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(l.url || '') + '" data-type="' + escapeAttr(lType) + '"></div>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    const hasCover = !!col.coverImageUrl;
    const coverHtml = hasCover
      ? '<img src="' + escapeAttr(col.coverImageUrl) + '" alt="' + escapeAttr(col.name) + '" style="width:100px; height:56px; object-fit:cover; border-radius:var(--radius-xs); border:1px solid var(--border); flex-shrink:0;">'
      : '';

    return '<div class="list-card" data-premade-id="' + escapeAttr(col.id) + '" style="flex-direction:column; align-items:stretch;">' +
      '<div class="list-card-header">' +
        (coverHtml ? '<div class="u-mr-10px">' + coverHtml + '</div>' : '') +
        '<div class="list-card-body">' +
          '<div class="u-ai-center u-gap-8px u-mb-4px" style="display:flex; flex-wrap:wrap;">' +
            '<span class="list-card-title u-cur-pointer" data-act="togglePremadeFolder" data-act-args="' + appActArgs([col.id]) + '">' + escapeHtml(col.name) + '</span>' +
            '<span class="u-fs-v_font_size_xs u-p-2px_8px u-br-v_radius_pill u-bg-v_surface_2_rgba_255_255_255_0_04 u-c-v_muted u-bd-1px_solid_v_border">' + listCount + (listCount === 1 ? ' list' : ' lists') + '</span>' +
            '<span class="u-fs-v_font_size_xxs u-p-2px_6px u-br-v_radius_pill u-bg-v_surface u-c-v_muted u-bd-1px_solid_v_border">' + escapeHtml(col.tileShape || 'LANDSCAPE') + '</span>' +
          '</div>' +
          (col.description ? '<div class="list-card-meta"><span>' + escapeHtml(col.description) + '</span></div>' : '') +
        '</div>' +
        '<div class="list-card-actions u-ai-center u-gap-6px" style="display:flex; flex-wrap:wrap;">' +
          (inFolders
            ? '<button type="button" class="lc-btn secondary" disabled style="opacity:0.6; cursor:default;">&#x2713; In Your Folders</button>'
            : '<button type="button" class="lc-btn primary" data-act="addPremadeToCustomCollections" data-act-args="' + appActArgs([col.id]) + '">+ Add to Your Folders</button>'
          ) +
          '<button type="button" class="lc-btn list-add-btn secondary' + (isAdded ? ' is-added' : '') + '"' + (isAdded ? ' style="color:var(--danger);"' : '') +
            ' data-act="toggleCustomCollectionCatalog" data-act-args="' + appActArgs([col.id, isAdded]) + '" title="Add or remove this folder from your Stremio &amp; Addon catalogs">' + (isAdded ? 'Remove' : '+ Add to Catalogs') + '</button>' +
          '<button type="button" class="lc-btn secondary" data-act="pushSinglePremadeToNuvio" data-act-args="' + appActArgs([col.id]) + '" title="Push this folder to your connected Nuvio account">Push to Nuvio</button>' +
          '<button type="button" class="lc-btn secondary" data-act="togglePremadeFolder" data-act-args="' + appActArgs([col.id]) + '">' + (isExpanded ? 'Hide Lists' : 'View Lists') + '</button>' +
        '</div>' +
      '</div>' +
      listsPreviewHtml +
    '</div>';
  }).join('');

  if (typeof populateSearchResultPosters === 'function') {
    setTimeout(populateSearchResultPosters, 0);
  }
}

function togglePremadeFolder(id) {
  if (!window._expandedPremadeFolders) window._expandedPremadeFolders = new Set();
  if (window._expandedPremadeFolders.has(id)) {
    window._expandedPremadeFolders.delete(id);
  } else {
    window._expandedPremadeFolders.add(id);
  }
  renderPremadeCollections();
  if (typeof populateSearchResultPosters === 'function') {
    setTimeout(populateSearchResultPosters, 0);
  }
}

function addPremadeToCustomCollections(premadeId) {
  const premade = getPremadeCollections();
  const target = premade.find(function (p) { return p.id === premadeId; });
  if (!target) return;
  const current = loadCustomCollections();
  const exists = current.some(function (c) { return (c.name || '').toLowerCase() === target.name.toLowerCase(); });
  if (exists) {
    showToast('"' + target.name + '" is already in your collection folders.', 'info');
    return;
  }
  current.push(JSON.parse(JSON.stringify(target)));
  saveCustomCollections(current);
  renderCustomCollections();
  renderPremadeCollections();
  showToast('Added "' + target.name + '" to your collection folders.', 'success');
}

function addAllPremadeCollections() {
  const current = loadCustomCollections();
  const premade = getPremadeCollections();
  const existingNames = new Set(current.map(function (c) { return (c.name || '').toLowerCase(); }));
  let added = 0;
  premade.forEach(function (p) {
    if (!existingNames.has((p.name || '').toLowerCase())) {
      current.push(JSON.parse(JSON.stringify(p)));
      added++;
    }
  });
  if (added > 0) {
    saveCustomCollections(current);
    renderCustomCollections();
    renderPremadeCollections();
    showToast('Added ' + added + ' premade collection(s) to your folders.', 'success');
  } else {
    showToast('All premade collections are already in your folders.', 'info');
  }
}

function pushSinglePremadeToNuvio(colId) {
  openSyncNuvioModal(colId);
}

function removeListFromSavedCollection(colId, listIdx) {
  const collections = loadCustomCollections();
  const col = collections.find(function (c) { return c.id === colId; });
  if (!col || !Array.isArray(col.lists)) return;
  col.lists.splice(listIdx, 1);
  saveCustomCollections(collections);
  showToast('List removed from collection.', 'success');
  renderCustomCollections();
}

function deleteCustomCollection(id) {
  const collections = loadCustomCollections();
  const col = collections.find(function (c) { return c.id === id; });
  const name = col ? col.name : 'this collection';
  if (typeof appShellDialog === 'function') {
    appShellDialog({
      title: 'Delete "' + name + '"?',
      message: 'This will delete the collection folder. The underlying lists will not be affected.',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep'
    }).then(function (confirmed) {
      if (confirmed) {
        const next = collections.filter(function (c) { return c.id !== id; });
        saveCustomCollections(next);
        showToast('Deleted "' + name + '".', 'success');
        renderCustomCollections();
      }
    });
  } else {
    const next = collections.filter(function (c) { return c.id !== id; });
    saveCustomCollections(next);
    showToast('Deleted "' + name + '".', 'success');
    renderCustomCollections();
  }
}

function toggleCustomCollectionCatalog(id, isAdded) {
  const collections = loadCustomCollections();
  const col = collections.find(function (c) { return c.id === id; });
  if (!col) return;
  if (!col.lists || !col.lists.length) {
    showToast('Add at least one list to "' + col.name + '" before installing to Catalogs.', 'error');
    return;
  }

  const nl = String.fromCharCode(10);
  const movieUrls = col.lists.filter(function (l) { return l.type !== 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
  const seriesUrls = col.lists.filter(function (l) { return l.type === 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
  const primaryUrl = movieUrls.length ? movieUrls.join(nl) : col.lists.map(function (l) { return l.url; }).join(nl);
  const primaryType = seriesUrls.length && !movieUrls.length ? 'series' : 'movie';

  if (isAdded) {
    if (movieUrls.length) removeListFromConfig(movieUrls.join(nl), 'movie');
    if (seriesUrls.length) removeListFromConfig(seriesUrls.join(nl), 'series');
    removeListFromConfig(primaryUrl, primaryType);
    if (typeof showAddedToast === 'function') {
      showAddedToast('Removed "' + col.name + '" from your Catalogs.');
    }
  } else {
    if (movieUrls.length && seriesUrls.length) {
      addRow(col.name + ' (Movies)', movieUrls.join(nl), 'movie', true, col.name);
      addRow(col.name + ' (Shows)', seriesUrls.join(nl), 'series', true, col.name);
    } else if (seriesUrls.length) {
      addRow(col.name, seriesUrls.join(nl), 'series', true, col.name);
    } else {
      addRow(col.name, primaryUrl, 'movie', true, col.name);
    }
    if (typeof showAddedToast === 'function') {
      showAddedToast('Added "' + col.name + '" to your Catalogs.');
    }
  }
  renderCustomCollections();
}

function addAllCollectionsToStremio() {
  const collections = loadCustomCollections();
  if (!collections.length) {
    showToast('No collection folders to add.', 'info');
    return;
  }
  let addedCount = 0;
  const nl = String.fromCharCode(10);
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (!col || !col.lists || !col.lists.length) continue;
    const movieUrls = col.lists.filter(function (l) { return l.type !== 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
    const seriesUrls = col.lists.filter(function (l) { return l.type === 'series'; }).map(function (l) { return l.url; }).filter(Boolean);
    if (movieUrls.length && seriesUrls.length) {
      if (typeof addRow === 'function') {
        addRow(col.name + ' (Movies)', movieUrls.join(nl), 'movie', true, col.name);
        addRow(col.name + ' (Shows)', seriesUrls.join(nl), 'series', true, col.name);
        addedCount++;
      }
    } else if (movieUrls.length) {
      if (typeof addRow === 'function') {
        addRow(col.name, movieUrls.join(nl), 'movie', true, col.name);
        addedCount++;
      }
    } else if (seriesUrls.length) {
      if (typeof addRow === 'function') {
        addRow(col.name, seriesUrls.join(nl), 'series', true, col.name);
        addedCount++;
      }
    }
  }
  if (typeof saveConfig === 'function') saveConfig();
  if (typeof renderCustomCollections === 'function') renderCustomCollections();
  if (typeof showAddedToast === 'function') {
    showAddedToast('Added ' + addedCount + ' collection folder(s) to your Stremio catalogs!');
  } else {
    showToast('Added ' + addedCount + ' collection folder(s) to your Stremio catalogs!', 'success');
  }
}
window.addAllCollectionsToStremio = addAllCollectionsToStremio;

function extractNuvioCollections(raw) {
  let val = raw;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (e) { return []; }
  }
  if (!val) return [];
  if (val.collections_json != null) return extractNuvioCollections(val.collections_json);
  if (val.p_collections_json != null) return extractNuvioCollections(val.p_collections_json);
  if (val.collections != null) return extractNuvioCollections(val.collections);
  if (val.p_collections != null) return extractNuvioCollections(val.p_collections);
  if (val.data != null) return extractNuvioCollections(val.data);
  if (Array.isArray(val)) {
    const out = [];
    for (let i = 0; i < val.length; i++) {
      const item = val[i];
      if (!item) continue;
      if (item.collections_json != null) {
        out.push.apply(out, extractNuvioCollections(item.collections_json));
      } else if (item.p_collections_json != null) {
        out.push.apply(out, extractNuvioCollections(item.p_collections_json));
      } else if (item.collections != null) {
        out.push.apply(out, extractNuvioCollections(item.collections));
      } else if (item.p_collections != null) {
        out.push.apply(out, extractNuvioCollections(item.p_collections));
      } else if (item.data != null) {
        out.push.apply(out, extractNuvioCollections(item.data));
      } else {
        const itemTitle = String(item.title || item.name || '').trim();
        const hasFolders = Array.isArray(item.folders) && item.folders.length > 0;
        const hasSources = Array.isArray(item.catalogSources) && item.catalogSources.length > 0;
        if (itemTitle || hasFolders || hasSources) {
          out.push(item);
        }
      }
    }
    return out;
  }
  if (typeof val === 'object') {
    const valTitle = String(val.title || val.name || '').trim();
    const hasFolders = Array.isArray(val.folders) && val.folders.length > 0;
    const hasSources = Array.isArray(val.catalogSources) && val.catalogSources.length > 0;
    if (valTitle || hasFolders || hasSources) {
      return [val];
    }
  }
  return [];
}

function stripMediaSuffix(str) {
  if (!str) return '';
  const re = /[ \t]*[(](?:movies?|shows?|series|tv)[)][ \t]*$/ig;
  return String(str).replace(re, '').replace(re, '').trim();
}

function addNewNuvioCollection(existing, incoming, options) {
  const opts = options || {};
  const existingArr = extractNuvioCollections(existing);
  const incomingArr = extractNuvioCollections(incoming);

  // Clean existing collections: filter out empty stubs (0 folders & 0 sources)
  const cleanedExisting = existingArr.filter(function (c) {
    if (!c) return false;
    const cFolders = Array.isArray(c.folders) ? c.folders : [];
    const cSources = Array.isArray(c.catalogSources) ? c.catalogSources : [];
    return cFolders.length > 0 || cSources.length > 0;
  });

  if (!incomingArr.length) return cleanedExisting;

  const newCols = incomingArr.map(function (inCol) {
    const rawName = opts.collectionName || inCol.title || inCol.name || 'My Lists Collections';
    const colName = stripMediaSuffix(rawName) || 'My Lists Collections';
    const colId = inCol.id && !cleanedExisting.some(function (e) { return e.id === inCol.id; })
      ? inCol.id
      : 'col_mylists_' + Math.random().toString(36).slice(2, 8);

    const cleanFolders = (Array.isArray(inCol.folders) ? inCol.folders : [inCol]).map(function (inF) {
      const cleanF = Object.assign({}, inF, {
        hidden: false,
        isVisible: true,
        enabled: true
      });
      if (Array.isArray(cleanF.catalogSources)) {
        cleanF.catalogSources = cleanF.catalogSources.map(function (cs) {
          let cName = String(cs.name || cs.title || cs.catalogId || '').trim();
          cName = stripMediaSuffix(cName);
          return Object.assign({}, cs, {
            name: cName,
            title: cName
          });
        });
      }
      return cleanF;
    });

    return Object.assign({}, inCol, {
      id: colId,
      title: colName,
      name: colName,
      viewMode: inCol.viewMode || 'FOLLOW_LAYOUT',
      showAllTab: false,
      pinToTop: false,
      focusGlowEnabled: true,
      hidden: false,
      isVisible: true,
      enabled: true,
      folders: cleanFolders
    });
  });

  return cleanedExisting.concat(newCols);
}

function mergeNuvioCollections(existing, incoming) {
  const existingArr = extractNuvioCollections(existing);
  const incomingArr = extractNuvioCollections(incoming);

  if (!existingArr.length) return incomingArr;
  if (!incomingArr.length) return existingArr;

  // Preserve all collections from other providers / community templates 100% untouched
  const otherCollections = [];
  let myListsCol = null;

  for (let i = 0; i < existingArr.length; i++) {
    const c = existingArr[i];
    if (!c) continue;
    const cTitle = String(c.title || c.name || '').trim();
    const cFolders = Array.isArray(c.folders) ? c.folders : [];
    const cSources = Array.isArray(c.catalogSources) ? c.catalogSources : [];
    if (cFolders.length === 0 && cSources.length === 0) {
      // Discard empty/corrupted DB stubs (e.g. 8467ec44-2731-4b0f-a8b5-48e42d215150 with 0 folders)
      continue;
    }

    const isMyLists = (c.id && (c.id === 'my-lists-collections' || c.id === 'my-lists-addon')) ||
                      (cTitle && (cTitle.toLowerCase() === 'my lists collections' || cTitle.toLowerCase() === 'my lists addon' || cTitle.toLowerCase() === 'my lists'));
    if (isMyLists) {
      if (!myListsCol) {
        myListsCol = JSON.parse(JSON.stringify(c));
      } else if (cFolders.length > 0) {
        if (!Array.isArray(myListsCol.folders)) myListsCol.folders = [];
        myListsCol.folders.push.apply(myListsCol.folders, JSON.parse(JSON.stringify(cFolders)));
      }
    } else {
      otherCollections.push(JSON.parse(JSON.stringify(c)));
    }
  }

  if (!myListsCol) {
    myListsCol = {
      id: 'my-lists-collections',
      title: 'My Lists Collections',
      name: 'My Lists Collections',
      viewMode: 'FOLLOW_LAYOUT',
      showAllTab: false,
      pinToTop: false,
      focusGlowEnabled: true,
      hidden: false,
      isVisible: true,
      enabled: true,
      folders: []
    };
  } else {
    myListsCol.id = 'my-lists-collections';
    myListsCol.title = 'My Lists Collections';
    myListsCol.name = 'My Lists Collections';
    myListsCol.hidden = false;
    myListsCol.isVisible = true;
    myListsCol.enabled = true;
    if (!Array.isArray(myListsCol.folders)) myListsCol.folders = [];
  }

  // Merge incoming folders ONLY into myListsCol. If an incoming collection matches otherCollections, update that collection.
  for (let i = 0; i < incomingArr.length; i++) {
    const inCol = incomingArr[i];
    if (!inCol) continue;
    const inTitle = String(inCol.title || inCol.name || '').trim();
    const isIncomingMyLists = (inCol.id && (inCol.id === 'my-lists-collections' || inCol.id === 'my-lists-addon')) ||
                             (inTitle && (inTitle.toLowerCase() === 'my lists collections' || inTitle.toLowerCase() === 'my lists addon' || inTitle.toLowerCase() === 'my lists'));

    if (inCol.id && !isIncomingMyLists) {
      const existingOtherIdx = otherCollections.findIndex(function (oc) { return oc.id === inCol.id; });
      if (existingOtherIdx !== -1) {
        otherCollections[existingOtherIdx] = JSON.parse(JSON.stringify(inCol));
        continue;
      }
    }

    // Folders intended for My Lists Collections
    const foldersToMerge = Array.isArray(inCol.folders) ? inCol.folders : [inCol];
    for (let j = 0; j < foldersToMerge.length; j++) {
      const inF = foldersToMerge[j];
      if (!inF || (!inF.id && !inF.title && !inF.name)) continue;
      const cleanFolder = Object.assign({}, inF, {
        hidden: false,
        isVisible: true,
        enabled: true
      });
      if (Array.isArray(cleanFolder.catalogSources)) {
        cleanFolder.catalogSources = cleanFolder.catalogSources.map(function (cs) {
          let cName = String(cs.name || cs.title || cs.catalogId || '').trim();
          cName = stripMediaSuffix(cName);
          return Object.assign({}, cs, {
            name: cName,
            title: cName
          });
        });
      }
      const fIdx = myListsCol.folders.findIndex(function (f) {
        return (f.id && inF.id && f.id === inF.id) ||
               (f.title && inF.title && f.title.toLowerCase() === inF.title.toLowerCase()) ||
               (f.name && inF.name && f.name.toLowerCase() === inF.name.toLowerCase());
      });
      if (fIdx !== -1) {
        myListsCol.folders[fIdx] = Object.assign({}, myListsCol.folders[fIdx], cleanFolder);
      } else {
        myListsCol.folders.push(JSON.parse(JSON.stringify(cleanFolder)));
      }
    }
  }

  return otherCollections.concat([myListsCol]);
}

function buildNuvioCollectionsPayload(collections) {
  const cols = collections || loadCustomCollections();
  return [
    {
      id: 'my-lists-collections',
      title: 'My Lists Collections',
      name: 'My Lists Collections',
      viewMode: 'FOLLOW_LAYOUT',
      showAllTab: false,
      pinToTop: false,
      focusGlowEnabled: true,
      backdropImageUrl: getNuvioBackdropUrl(),
      hidden: false,
      isVisible: true,
      enabled: true,
      folders: cols.map(function (col) {
        return {
          id: col.id || ('folder_' + Math.random().toString(36).slice(2, 8)),
          title: col.name || 'Untitled Folder',
          name: col.name || 'Untitled Folder',
          tileShape: col.tileShape || 'LANDSCAPE',
          hideTitle: !!col.hideTitle,
          coverImageUrl: col.coverImageUrl || '',
          hidden: false,
          isVisible: true,
          enabled: true,
          catalogSources: (col.lists || []).map(function (l) {
            let catId = l.catalogId;
            if (!catId) {
              if (l.url && typeof slugify === 'function') catId = slugify(l.url);
              else if (l.name && typeof slugify === 'function') catId = slugify(l.name);
              else catId = l.name || 'catalog';
            }
            let cleanName = stripMediaSuffix(l.name || catId);
            return {
              addonId: l.addonId || col.addonId || 'app.my-list',
              catalogId: catId,
              name: cleanName || catId,
              title: cleanName || catId,
              type: l.type || 'movie'
            };
          })
        };
      })
    }
  ];
}

function getNuvioBackdropUrl() {
  return (window.location && window.location.origin ? window.location.origin : 'https://mylistsaddon.com') + '/icon.png';
}

function getNuvioManifestUrl() {
  const display = document.getElementById('manifestLinkDisplay');
  const txt = (display && display.innerText) ? display.innerText.trim() : '';
  if (txt && (txt.startsWith('http://') || txt.startsWith('https://'))) return txt;
  try {
    const saved = localStorage.getItem('myListAddon:lastInstallUrl');
    if (saved && (saved.startsWith('http://') || saved.startsWith('https://'))) return saved;
  } catch (e) {}
  if (window.myListAddonManifestUrl && (window.myListAddonManifestUrl.startsWith('http://') || window.myListAddonManifestUrl.startsWith('https://'))) {
    return window.myListAddonManifestUrl;
  }
  return (window.location && window.location.origin ? window.location.origin : 'https://mylistsaddon.com') + '/manifest.json';
}
window.getNuvioManifestUrl = getNuvioManifestUrl;

async function openSyncNuvioModal(targetColId) {
  window._syncNuvioTarget = targetColId || null;
  const modal = document.getElementById('syncNuvioModal');
  if (!modal) {
    executeNuvioCollectionsPush({ targetColId: targetColId });
    return;
  }

  const titleEl = document.getElementById('syncNuvioModalTitle');
  if (titleEl) {
    titleEl.textContent = 'Add to Profile';
  }

  const sel = document.getElementById('syncNuvioProfileSelect');
  if (sel) {
    sel.innerHTML = '<option value="1">James</option>';
  }

  const modeSel = document.getElementById('syncNuvioInstallMode');
  if (modeSel) {
    modeSel.value = 'new';
  }
  const nameInput = document.getElementById('syncNuvioCollectionName');
  if (nameInput) {
    let defaultName = 'My Lists Collections';
    if (targetColId) {
      const all = loadCustomCollections().concat((typeof getPremadeCollections === 'function') ? getPremadeCollections() : []);
      const one = all.find(function (c) { return c.id === targetColId; });
      if (one && one.name) defaultName = one.name;
    }
    nameInput.value = defaultName;
  }
  window._syncNuvioRemote = [];
  handleSyncNuvioModeChange();

  modal.style.display = 'flex';
  if (typeof lockBackgroundScroll === 'function') lockBackgroundScroll();

  try {
    const res = await mediaAppUiCall('nuvio', 'settings', 'GET');
    if (res && res.ok && res.data && Array.isArray(res.data.profiles) && res.data.profiles.length > 0) {
      if (sel) {
        sel.innerHTML = res.data.profiles.map(function (p) {
          const idx = p.index != null ? p.index : (p.profile_index != null ? p.profile_index : 1);
          const name = p.name || ('Profile ' + idx);
          return '<option value="' + escapeAttr(String(idx)) + '">' + escapeHtml(name) + '</option>';
        }).join('');
      }
    }
  } catch (e) {}
  loadSyncNuvioTargets();
}

async function loadSyncNuvioTargets() {
  const sel = document.getElementById('syncNuvioTargetSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading collections\u2026</option>';
  let cols = [];
  try {
    const res = await mediaAppUiCall('nuvio', 'collections', 'GET');
    if (res && res.ok && res.data) cols = extractNuvioCollections(res.data.collections);
  } catch (e) {}
  window._syncNuvioRemote = cols;
  if (!cols.length) {
    sel.innerHTML = '<option value="">No collections found in Nuvio</option>';
    return;
  }
  sel.innerHTML = cols.map(function (c) {
    const label = String(c.title || c.name || c.id || 'Untitled');
    const n = Array.isArray(c.folders) ? c.folders.length : 0;
    return '<option value="' + escapeAttr(String(c.id || '')) + '">' + escapeHtml(label) + ' (' + n + ' folder' + (n === 1 ? '' : 's') + ')</option>';
  }).join('');
}

function closeSyncNuvioModal() {
  const modal = document.getElementById('syncNuvioModal');
  if (modal) modal.style.display = 'none';
  if (typeof unlockBackgroundScroll === 'function') unlockBackgroundScroll();
  window._syncNuvioTarget = null;
}

function handleSyncNuvioModeChange() {
  const modeSel = document.getElementById('syncNuvioInstallMode');
  const hintEl = document.getElementById('syncNuvioModeHint');
  const btn = document.getElementById('syncNuvioSubmitBtn');
  const mode = modeSel ? modeSel.value : 'new';
  const nameRow = document.getElementById('syncNuvioNameRow');
  const targetRow = document.getElementById('syncNuvioTargetRow');
  if (nameRow) nameRow.style.display = mode === 'new' ? '' : 'none';
  if (targetRow) targetRow.style.display = mode === 'merge' ? '' : 'none';

  if (hintEl) {
    if (mode === 'new') {
      hintEl.textContent = 'This will create a new collection with the name below and leave every existing collection untouched.';
    } else if (mode === 'merge') {
      hintEl.textContent = 'This will add these folders to the collection you pick and leave all other collections untouched.';
    } else {
      hintEl.textContent = 'This will REMOVE every collection on this Nuvio profile (including ones from other providers) and keep only this one.';
    }
  }
  if (btn) {
    btn.textContent = mode === 'new' ? 'Add collection' : (mode === 'merge' ? 'Merge into collection' : 'Replace all collections');
  }
}

async function confirmSyncToNuvio() {
  const profileSel = document.getElementById('syncNuvioProfileSelect');
  const modeSel = document.getElementById('syncNuvioInstallMode');
  const profileId = profileSel ? profileSel.value : '1';
  const installMode = modeSel ? modeSel.value : 'new';
  const targetColId = window._syncNuvioTarget;
  const nameInput = document.getElementById('syncNuvioCollectionName');
  const targetSel = document.getElementById('syncNuvioTargetSelect');
  const collectionName = nameInput ? nameInput.value.trim() : '';
  const mergeTargetId = targetSel ? targetSel.value : '';

  if (installMode === 'merge' && !mergeTargetId) {
    showToast('Pick which Nuvio collection to merge into.', 'info');
    return;
  }
  if (installMode === 'replace' && !window.confirm('This removes ALL collections on this Nuvio profile, including ones from other providers. Continue?')) {
    return;
  }

  closeSyncNuvioModal();
  await executeNuvioCollectionsPush({ profileId: profileId, installMode: installMode, targetColId: targetColId, collectionName: collectionName, mergeTargetId: mergeTargetId });
}

function syncCollectionsToNuvio() {
  openSyncNuvioModal();
}

function pushSingleCollectionToNuvio(colId) {
  openSyncNuvioModal(colId);
}

async function executeNuvioCollectionsPush(opts) {
  const options = opts || {};
  const profileId = options.profileId || 1;
  const installMode = options.installMode || 'new';
  const targetColId = options.targetColId;

  const current = loadCustomCollections();
  let collectionsToPush = current;
  let pushName = 'collections';

  if (targetColId) {
    const premade = (typeof getPremadeCollections === 'function') ? getPremadeCollections() : [];
    const premadeCol = premade.find(function (c) { return c.id === targetColId; });
    if (premadeCol) {
      const idx = current.findIndex(function (c) { return c.id === premadeCol.id || (c.name && premadeCol.name && c.name.toLowerCase() === premadeCol.name.toLowerCase()); });
      if (idx !== -1) {
        current[idx] = Object.assign({}, current[idx], premadeCol);
      } else {
        current.push(JSON.parse(JSON.stringify(premadeCol)));
      }
      saveCustomCollections(current);
      renderCustomCollections();
    }

    const single = current.find(function (c) { return c.id === targetColId; });
    if (single) {
      pushName = single.name || 'folder';
      collectionsToPush = [single];
    }
  }

  if (!collectionsToPush.length) {
    showToast('No collections to push.', 'info');
    return;
  }

  const payload = buildNuvioCollectionsPayload(collectionsToPush);
  const manifestUrl = getNuvioManifestUrl();
  const allLists = collectionsToPush.reduce(function (acc, c) { return acc.concat(c.lists || []); }, []);

  showToast('Pushing to Nuvio\u2026', 'info');

  let cachedRemote = [];
  try {
    const raw = localStorage.getItem('myListAddon:nuvioRemoteCollections');
    if (raw) cachedRemote = extractNuvioCollections(raw);
  } catch (e) {}

  try {
    const pullRes = await mediaAppUiCall('nuvio', 'collections', 'GET');
    if (pullRes && pullRes.ok && pullRes.data && pullRes.data.collections) {
      const extracted = extractNuvioCollections(pullRes.data.collections);
      if (extracted && extracted.length > 0) {
        cachedRemote = extracted;
        try { localStorage.setItem('myListAddon:nuvioRemoteCollections', JSON.stringify(extracted)); } catch (e) {}
      }
    }
  } catch (e) {}

  const res = await mediaAppUiCall('nuvio', 'collections', 'POST', {
    profileId: profileId,
    installMode: installMode,
    collectionName: options.collectionName || (targetColId && collectionsToPush.length === 1 && collectionsToPush[0].name) || 'My Lists Collections',
    targetCollectionId: options.mergeTargetId || '',
    collections: payload,
    knownCollections: cachedRemote,
    manifestUrl: manifestUrl,
    collectionLists: allLists
  });

  if (res && res.ok) {
    if (res.data && res.data.collections) {
      try { localStorage.setItem('myListAddon:nuvioRemoteCollections', JSON.stringify(res.data.collections)); } catch (e) {}
    }
    const modeDesc = installMode === 'new' ? 'added as new collection' : (installMode === 'merge' ? 'merged into the chosen collection' : 'replaced all collections');
    let msg = 'Pushed "' + pushName + '" to Nuvio (' + modeDesc + ').';
    if (res.data && res.data.addonInstalled) {
      msg += ' My Lists Addon was auto-installed in Nuvio!';
    }
    showToast(msg, 'success');
  } else {
    showToast(mediaAppUiMessage(res, 'Could not push to Nuvio. Check your connection in Settings.'), 'error');
  }
}

async function pullCollectionsFromNuvio() {
  showToast('Pulling collections from Nuvio\u2026', 'info');
  const res = await mediaAppUiCall('nuvio', 'collections', 'GET');
  if (res && res.ok && res.data && res.data.collections) {
    const extracted = extractNuvioCollections(res.data.collections);
    if (extracted && extracted.length > 0) {
      try { localStorage.setItem('myListAddon:nuvioRemoteCollections', JSON.stringify(extracted)); } catch (e) {}
    }
    const imported = parseNuvioCollectionsJson(res.data.collections);
    if (!imported.length) {
      showToast('Nuvio has no collection folders saved for this profile.', 'info');
      return;
    }
    const current = loadCustomCollections();
    const merged = current.slice();
    let count = 0;
    for (let i = 0; i < imported.length; i++) {
      const imp = imported[i];
      const idx = merged.findIndex(function (c) { return c.id === imp.id; });
      if (idx !== -1) {
        merged[idx] = imp;
      } else {
        merged.push(imp);
        count++;
      }
    }
    saveCustomCollections(merged);
    renderCustomCollections();
    showToast('Pulled ' + imported.length + ' collection folder(s) from Nuvio (' + count + ' new).', 'success');
  } else {
    showToast(mediaAppUiMessage(res, 'Could not pull collections from Nuvio. Check your connection in Settings.'), 'error');
  }
}

function exportNuvioCollectionsJson() {
  const collections = loadCustomCollections();
  if (!collections.length) {
    showToast('No collection folders to export yet.', 'info');
    return;
  }
  const payload = buildNuvioCollectionsPayload(collections);
  const jsonStr = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'collections.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Exported collections.json for Nuvio.', 'success');
}

function parseNuvioCollectionsJson(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }
  if (!data) return [];
  let folders = [];
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (item && Array.isArray(item.folders)) {
        folders = folders.concat(item.folders);
      } else if (item && (item.catalogSources || item.title || item.name)) {
        folders.push(item);
      }
    }
  } else if (typeof data === 'object') {
    if (Array.isArray(data.folders)) {
      folders = data.folders;
    } else if (data.catalogSources) {
      folders = [data];
    }
  }

  return folders.filter(Boolean).map(function (f) {
    const lists = Array.isArray(f.catalogSources) ? f.catalogSources.map(function (cs) {
      const catId = cs.catalogId || cs.name || '';
      let url = cs.url || '';
      if (!url && catId && typeof CHART_SLUG_ENTRIES !== 'undefined') {
        const match = CHART_SLUG_ENTRIES.find(function (c) {
          return c.slug === catId || (typeof slugify === 'function' && (slugify(c.name) === catId || slugify(c.movieUrl || '') === catId || slugify(c.showUrl || '') === catId));
        });
        if (match) {
          url = cs.type === 'series' ? (match.showUrl || match.movieUrl) : (match.movieUrl || match.showUrl);
        }
      }
      return {
        name: cs.name || cs.catalogId || 'Catalog Item',
        url: url || ('catalog:' + (cs.addonId || 'app.my-list') + ':' + catId),
        type: cs.type || 'movie',
        addonId: cs.addonId || 'app.my-list',
        catalogId: catId
      };
    }) : [];

    return {
      id: f.id || ('col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      name: f.title || f.name || 'Imported Collection',
      description: f.description || '',
      tileShape: f.tileShape || 'LANDSCAPE',
      hideTitle: !!f.hideTitle,
      addonId: (f.catalogSources && f.catalogSources[0] && f.catalogSources[0].addonId) || 'app.my-list',
      coverImageUrl: f.coverImageUrl || '',
      lists: lists,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  });
}

function openImportNuvioModal() {
  const modal = document.getElementById('importNuvioCollectionsModal');
  if (!modal) return;
  const fileInput = document.getElementById('importNuvioFileInput');
  if (fileInput) fileInput.value = '';
  const textarea = document.getElementById('importNuvioJsonTextarea');
  if (textarea) textarea.value = '';
  modal.style.display = 'flex';
  if (typeof lockBackgroundScroll === 'function') lockBackgroundScroll(true);
}

function closeImportNuvioModal() {
  const modal = document.getElementById('importNuvioCollectionsModal');
  if (!modal) return;
  modal.style.display = 'none';
  if (typeof lockBackgroundScroll === 'function') lockBackgroundScroll(false);
}

function handleNuvioFileSelected(event) {
  const input = event && event.target ? event.target : document.getElementById('importNuvioFileInput');
  if (!input || !input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = function (e) {
    const text = e.target.result;
    const textarea = document.getElementById('importNuvioJsonTextarea');
    if (textarea) textarea.value = text;
  };
  reader.readAsText(file);
}

function submitImportNuvioModal() {
  const textarea = document.getElementById('importNuvioJsonTextarea');
  const raw = textarea ? textarea.value.trim() : '';
  if (!raw) {
    showToast('Paste JSON or choose a collections.json file first.', 'error');
    return;
  }
  const parsed = parseNuvioCollectionsJson(raw);
  if (!parsed.length) {
    showToast('Could not find any collection folders in this JSON.', 'error');
    return;
  }
  const current = loadCustomCollections();
  const merged = current.slice();
  let count = 0;
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    const idx = merged.findIndex(function (c) { return c.id === item.id; });
    if (idx !== -1) {
      merged[idx] = item;
    } else {
      merged.push(item);
      count++;
    }
  }
  saveCustomCollections(merged);
  closeImportNuvioModal();
  renderCustomCollections();
  showToast('Imported ' + parsed.length + ' collection folder(s) (' + count + ' new).', 'success');
}

function renderCollectionsView() {
  renderCustomCollections();
  renderPremadeCollections();
  renderCollectionsMediaApps();
}

function renderCollectionsCurated() {
  const box = document.getElementById('collectionsCuratedResult');
  if (!box) return;
  box.innerHTML = FEATURED_TMDB_COLLECTIONS.map(function (c) {
    const added = typeof isListAddedToConfig === 'function' && (isListAddedToConfig(c.url, 'movie') || isListAddedToConfig('tmdb:collection:' + c.id, 'movie'));
    return '<div class="list-card" data-list-type="movie" data-name="' + escapeAttr(c.name) + '" data-url="' + escapeAttr(c.url) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title u-cur-pointer" data-act="openCollectionDetails" data-act-args="' + appActArgs([c.name, c.url]) + '">' + escapeHtml(c.name) + '</div>' +
          '<div class="list-card-meta"><span>TMDB Franchise Collection</span></div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn list-add-btn secondary' + (added ? ' is-added' : '') + '"' + (added ? ' style="color:var(--danger);"' : '') +
            ' data-act="toggleCollectionAdd" data-act-args="' + appActArgs([c.name, c.url, added]) + '">' + (added ? 'Remove' : '+ Add') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(c.name) + '" data-url="' + escapeAttr(c.url) + '" data-type="movie" data-creator="" data-items="" data-likes="0"></div>' +
    '</div>';
  }).join('');
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

function renderCollectionsMediaApps() {
  const box = document.getElementById('collectionsMediaAppsResult');
  if (!box) return;
  const providers = ['stremio', 'nuvio'];
  box.innerHTML = providers.map(function (provider) {
    const name = MEDIA_APP_UI_NAMES[provider];
    const live = !!mediaAppListsLive[provider];
    const busy = !!mediaAppListsBusy[provider];
    if (!live) {
      return '<div class="u-p-12px u-mb-10px u-bg-v_surface_2_rgba_255_255_255_0_04 u-br-v_radius_sm u-bd-1px_solid_v_border">' +
        '<div class="u-ai-center u-jc-space_between u-gap-12px" style="display:flex; flex-wrap:wrap;">' +
          '<div>' +
            '<div class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">' + escapeHtml(name) + ' Collections</div>' +
            '<p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_xs">Connect your ' + escapeHtml(name) + ' account in Settings to sync and install your personal history and continue watching collections.</p>' +
          '</div>' +
          '<button type="button" class="lc-btn secondary" data-act="goToExternalSettings">Connect ' + escapeHtml(name) + '</button>' +
        '</div>' +
      '</div>';
    }
    const listsHtml = MEDIA_APP_LISTS.map(function (l) {
      const urls = mediaAppListUrls(provider, l.slug);
      const added = !!urls && typeof isListAddedToConfig === 'function' && isListAddedToConfig(urls.movie, 'movie') && isListAddedToConfig(urls.series, 'series');
      const listName = name + ' ' + l.title;
      return '<div class="list-card" data-list-type="mixed" data-name="' + escapeAttr(listName) + '"' + (urls ? ' data-url="' + escapeAttr(urls.mixed) + '"' : '') + '>' +
        '<div class="list-card-header">' +
          '<div class="list-card-body">' +
            '<div class="list-card-title u-cur-pointer" data-act="openMediaAppListDetails" data-act-args="' + appActArgs([provider, l.slug]) + '">' + escapeHtml(listName) + '</div>' +
            '<div class="list-card-meta"><span>' + escapeHtml(l.blurb) + '</span></div>' +
          '</div>' +
          '<div class="list-card-actions">' +
            '<button type="button" class="lc-btn list-add-btn secondary' + (added ? ' is-added' : '') + '"' + (added ? ' style="color:var(--danger);"' : '') +
              ' data-act="toggleMediaAppListAdd" data-act-args="' + appActArgs([provider, l.slug, added]) + '">' + (added ? 'Remove' : '+ Add') + '</button>' +
          '</div>' +
        '</div>' +
        (urls ? '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(urls.mixed) + '" data-type="mixed" data-creator="" data-items="" data-likes="0"></div>' : '') +
      '</div>';
    }).join('');

    return '<div class="u-mb-12px">' +
      '<div class="u-ai-center u-jc-space_between u-gap-12px u-mb-8px" style="display:flex;">' +
        '<div class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">' + escapeHtml(name) + ' Synced Collections</div>' +
        '<button type="button" class="lc-btn secondary u-fs-v_font_size_xs" data-act="syncMediaAppNow" data-act-args="' + appActArgs([provider, '@self']) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Syncing\u2026' : 'Sync now') + '</button>' +
      '</div>' +
      listsHtml +
    '</div>';
  }).join('');
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

async function searchCollections() {
  const input = document.getElementById('collectionsSearchInput');
  const box = document.getElementById('collectionsSearchResults');
  if (!input || !box) return;
  const rawQuery = (input.value || '').trim();
  if (!rawQuery) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  box.style.display = 'block';
  box.innerHTML = '<p class="u-mt-10px u-c-v_muted" role="status"><small>Searching collections\u2026</small></p>';

  const tmdbCollMatch = rawQuery.match(new RegExp('(?:themoviedb[.]org/collection/|tmdb:collection:)([0-9]+)', 'i')) || (rawQuery.match(/^[0-9]+$/) ? [null, rawQuery] : null);
  if (tmdbCollMatch && tmdbCollMatch[1]) {
    const id = tmdbCollMatch[1];
    const url = 'https://www.themoviedb.org/collection/' + id;
    const name = 'TMDB Collection ' + id;
    const added = typeof isListAddedToConfig === 'function' && (isListAddedToConfig(url, 'movie') || isListAddedToConfig('tmdb:collection:' + id, 'movie'));
    box.innerHTML = '<div class="shelf-header u-mb-10px"><h3 class="panel-title u-mb-0 u-fs-v_font_size_sm">Matching Collection</h3></div>' +
      '<div class="list-card" data-list-type="movie" data-name="' + escapeAttr(name) + '" data-url="' + escapeAttr(url) + '">' +
        '<div class="list-card-header">' +
          '<div class="list-card-body">' +
            '<div class="list-card-title u-cur-pointer" data-act="openCollectionDetails" data-act-args="' + appActArgs([name, url]) + '">' + escapeHtml(name) + '</div>' +
            '<div class="list-card-meta"><span>TMDB Franchise Collection #' + escapeHtml(id) + '</span></div>' +
          '</div>' +
          '<div class="list-card-actions">' +
            '<button type="button" class="lc-btn list-add-btn secondary' + (added ? ' is-added' : '') + '"' + (added ? ' style="color:var(--danger);"' : '') +
              ' data-act="toggleCollectionAdd" data-act-args="' + appActArgs([name, url, added]) + '">' + (added ? 'Remove' : '+ Add') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(name) + '" data-url="' + escapeAttr(url) + '" data-type="movie" data-creator="" data-items="" data-likes="0"></div>' +
      '</div>';
    if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
    return;
  }

  try {
    const res = await fetch(ORIGIN + '/api/tmdb-search-lists?q=' + encodeURIComponent(rawQuery));
    const data = await res.json().catch(function () { return {}; });
    const lists = (data && Array.isArray(data.lists)) ? data.lists : [];
    const collections = lists.filter(function (item) {
      return item.isCollection || (item.url && item.url.indexOf('/collection/') !== -1);
    });

    if (!collections.length) {
      box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>No collections found for "' + escapeHtml(rawQuery) + '". Try another franchise name or paste a collection URL.</small></p>';
      return;
    }

    box.innerHTML = '<div class="shelf-header u-mb-10px"><h3 class="panel-title u-mb-0 u-fs-v_font_size_sm">Search Results (' + collections.length + ')</h3></div>' +
      collections.map(function (c) {
        const added = typeof isListAddedToConfig === 'function' && isListAddedToConfig(c.url, 'movie');
        return '<div class="list-card" data-list-type="movie" data-name="' + escapeAttr(c.name) + '" data-url="' + escapeAttr(c.url) + '">' +
          '<div class="list-card-header">' +
            '<div class="list-card-body">' +
              '<div class="list-card-title u-cur-pointer" data-act="openCollectionDetails" data-act-args="' + appActArgs([c.name, c.url]) + '">' + escapeHtml(c.name) + '</div>' +
              '<div class="list-card-meta"><span>TMDB Franchise Collection</span></div>' +
            '</div>' +
            '<div class="list-card-actions">' +
              '<button type="button" class="lc-btn list-add-btn secondary' + (added ? ' is-added' : '') + '"' + (added ? ' style="color:var(--danger);"' : '') +
                ' data-act="toggleCollectionAdd" data-act-args="' + appActArgs([c.name, c.url, added]) + '">' + (added ? 'Remove' : '+ Add') + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(c.name) + '" data-url="' + escapeAttr(c.url) + '" data-type="movie" data-creator="" data-items="" data-likes="0"></div>' +
        '</div>';
      }).join('');
    if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
  } catch (err) {
    box.innerHTML = '<p class="u-mt-10px u-c-v_muted"><small>Could not search collections. Please try again.</small></p>';
  }
}

function onCollectionsSearchKey() {
  searchCollections();
}

function toggleCollectionAdd(name, url, isAdded) {
  if (isAdded) {
    removeListFromConfig(url, 'movie');
    if (typeof showAddedToast === 'function') {
      showAddedToast('Removed "' + name + '" from your Catalogs.');
    }
  } else {
    addRow(name, url, 'movie', true, 'Collections');
    if (typeof showAddedToast === 'function') {
      showAddedToast('Added "' + name + '" to your Catalogs.');
    }
  }
  renderCollectionsCurated();
  const searchBox = document.getElementById('collectionsSearchResults');
  if (searchBox && searchBox.style.display !== 'none') {
    searchCollections();
  }
}

function openCollectionDetails(name, url) {
  if (typeof openListDetailsPage === 'function') {
    openListDetailsPage(name, 'movie', url);
  }
}

function refreshCollectionsView() {
  renderCollectionsView();
  if (typeof refreshMediaAppConnections === 'function') refreshMediaAppConnections();
  showToast('Collections refreshed.', 'success');
}

function goToExternalSettings() {
  if (typeof switchTab === 'function') switchTab('settings');
  const externalPill = document.querySelector('#settingsSubnavBar button[data-sub="external"]');
  if (typeof switchSettingsSubmenu === 'function') switchSettingsSubmenu('external', externalPill);
}

window.renderPremadeCollections = renderPremadeCollections;
window.togglePremadeFolder = togglePremadeFolder;
window.addPremadeToCustomCollections = addPremadeToCustomCollections;
window.addAllPremadeCollections = addAllPremadeCollections;
window.pushSinglePremadeToNuvio = pushSinglePremadeToNuvio;
window.renderCollectionsView = renderCollectionsView;
window.refreshCollectionsView = refreshCollectionsView;
window.toggleCustomCollectionFolder = toggleCustomCollectionFolder;
window.pushSingleCollectionToNuvio = pushSingleCollectionToNuvio;
window.syncCollectionsToNuvio = syncCollectionsToNuvio;
window.openCreateCollectionModal = openCreateCollectionModal;
window.closeCreateCollectionModal = closeCreateCollectionModal;
window.submitCreateCollectionModal = submitCreateCollectionModal;
window.deleteCustomCollection = deleteCustomCollection;
window.removeListFromSavedCollection = removeListFromSavedCollection;
window.openSyncNuvioModal = openSyncNuvioModal;
window.closeSyncNuvioModal = closeSyncNuvioModal;
window.handleSyncNuvioModeChange = handleSyncNuvioModeChange;
window.confirmSyncToNuvio = confirmSyncToNuvio;
window.addNewNuvioCollection = addNewNuvioCollection;




