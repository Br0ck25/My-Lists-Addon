<div class="tab-panel" data-tab-panel="catalogs" id="content-catalogs" role="tabpanel" aria-labelledby="tab-desktop-catalogs" hidden>
  <!-- Top Submenu Pills for Catalogs -->
  <div class="subnav-pills-bar" id="catalogsFilterBar">
    <button type="button" class="subnav-pill active" data-sub="all" data-act="switchCatalogsSubmenu" data-act-args="[&quot;all&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> My Catalogs</button>
    <button type="button" class="subnav-pill" data-sub="quickadd" data-act="switchCatalogsSubmenu" data-act-args="[&quot;quickadd&quot;,&quot;@self&quot;]">Quick Add</button>
    <button type="button" class="subnav-pill" data-sub="bulk" data-act="switchCatalogsSubmenu" data-act-args="[&quot;bulk&quot;,&quot;@self&quot;]">Bulk Add</button>
  </div>

  <div class="lists-subpanel" id="catalogsSubShelves">
  <!-- Catalogs Management Card -->
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:12px;">
      <h2 class="shelf-title">Live Preview &amp; Editor</h2>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; align-items:center; gap:6px;">
        <button type="button" class="primary lc-btn" data-act="openAddShelfModal">+ New Catalog</button>
        <button type="button" class="secondary lc-btn" id="livePreviewEditBtn" data-act="toggleLivePreviewEdit">Edit</button>
        <button type="button" class="secondary lc-btn" data-act="renderLivePreview">Refresh Preview</button>
      </div>
    </div>
    <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Catalogs and lists you've added to your add-on. Reorder, edit, and preview your active shelves.</p>

    <div class="row" style="margin-bottom:12px; gap:8px;">
      <input type="text" id="listFilterInput" aria-label="Filter catalogs by name" placeholder="Filter catalogs by name..." data-act-on="input" data-act="filterLists">
      <select id="listGroupFilterSelect" aria-label="Filter catalogs by group" data-act="filterLists" style="flex:none; width:auto;">
        <option value="">All groups</option>
      </select>
    </div>

    <!-- Reorderable Catalog Shelves -->
    <div id="lists"></div>

    <!-- Duplicate rows toggle right above the Daily Randomizer -->
${newUi ? '    <div id="appShellHomeEditor"></div>' : ('    <div style="margin-top:16px; padding:12px 16px; background:var(--surface); border-radius:12px; border:1px solid var(--border);">' +
      '<div class="settings-toggle-row" style="padding:0;">' +
        '<div style="flex:1; min-width:0; padding-right:12px;">' +
          '<span style="font-weight:600; font-size:0.88rem; color:var(--text);">Hide titles already shown in rows above</span>' +
          '<p style="margin:2px 0 0; color:var(--muted); font-size:0.78rem;">The top row keeps everything; lower rows drop titles already shown above.</p>' +
        '</div>' +
        '<label class="ui-toggle" aria-label="Hide titles already shown in rows above">' +
          '<input type="checkbox" id="catalogsDedupeCheckbox"' + (initialDedupeAcrossLists ? ' checked' : '') + ' data-act="appActStoreSettingChecked" data-act-args="[&quot;myListAddon:dedupeAcrossLists&quot;,&quot;@checked&quot;]">' +
          '<span class="ui-toggle-slider"></span>' +
        '</label>' +
      '</div>' +
    '</div>')}

    <!-- 24-Hour Randomizer Controls -->
    <div style="margin-top:16px; padding:12px 16px; background:var(--surface); border-radius:12px; border:1px solid var(--border);">
      <div style="font-weight:600; font-size:0.92rem; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
        <span>Daily Randomizer</span>
      </div>
      <div>
        <div class="settings-toggle-row">
          <div style="flex:1; min-width:0; padding-right:12px;">
            <span style="font-weight:600; font-size:0.88rem; color:var(--text);">Shuffle Catalogs daily (every 24h)</span>
            <p style="margin:2px 0 0; color:var(--muted); font-size:0.78rem;">Rotates the order of your catalog rows once every 24 hours.</p>
          </div>
          <label class="ui-toggle" aria-label="Shuffle Catalogs daily (every 24h)">
            <input type="checkbox" id="shuffleShelvesCheckbox" data-act="saveState">
            <span class="ui-toggle-slider"></span>
          </label>
        </div>

        <div class="settings-toggle-row">
          <div style="flex:1; min-width:0; padding-right:12px;">
            <span style="font-weight:600; font-size:0.88rem; color:var(--text);">Shuffle items in Catalogs daily (every 24h)</span>
            <p style="margin:2px 0 0; color:var(--muted); font-size:0.78rem;">Randomizes the order of titles inside each catalog row every 24 hours.</p>
          </div>
          <label class="ui-toggle" aria-label="Shuffle items in Catalogs daily (every 24h)">
            <input type="checkbox" id="shuffleItemsCheckbox" data-act="saveState">
            <span class="ui-toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>

    <div class="catalog-actions-bar">
      <button type="button" data-act="removeAllLists" class="btn-danger">Remove All</button>
      <button type="button" class="btn-primary" data-act="generate">${isConfigureMode ? "Update Add-on" : "Generate Install Link"}</button>
    </div>
  </div>

  <!-- Undo Toast -->
  <div id="undoToast" class="undo-toast" style="display:none;">
    <span id="undoToastMsg"></span>
    <button type="button" class="secondary" data-act="performUndo">Undo</button>
  </div>

  <!-- Generated Install Link Result Box -->
  <div id="result"></div>

    </div>
  
  <div class="lists-subpanel" id="catalogsSubBulk" style="display:none;">
  <div class="panel" style="margin-top:0;">
    <h2 class="panel-title">Bulk Import Lists</h2>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste multiple list URLs at once, one per line. Each list is automatically detected and added to your catalogs.</p>
    <textarea id="bulkPasteBox" rows="5" style="width:100%;font-family:monospace;font-size:15px;" placeholder="https://mdblist.com/lists/user/list-one&#10;https://trakt.tv/users/user/lists/list-two&#10;https://www.themoviedb.org/list/12345"></textarea>
    <div class="actions" style="margin-top:12px;">
      <button type="button" class="primary" data-act="bulkAddLists" data-act-args="[&quot;@self&quot;]">Add All Lines as Catalogs</button>
    </div>
  </div>
  </div>

  <div class="lists-subpanel" id="catalogsSubQuickAdd" style="display:none;">
    <!-- Quick Add Search & Category Filter Toolbar -->
    <div class="qa-toolbar" id="qaToolbar">
      <div class="qa-search-box">
        <input type="text" id="quickAddSearchInput" aria-label="Search quick add charts" placeholder="Search charts & streaming services... (e.g. Netflix, Horror, Trending)" data-act-on="input" data-act="filterQuickAdd">
        <button type="button" class="qa-search-clear" id="quickAddSearchClearBtn" aria-label="Clear search" data-act="clearQuickAddSearch">&times;</button>
      </div>
      <div id="qaSearchCount"></div>
      <div class="subnav-pills-bar qa-category-bar" id="quickAddCategoryBar">
        <button type="button" class="subnav-pill active" data-qa-filter="all" data-act="filterQuickAddCategory" data-act-args="[&quot;all&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> All</button>
        <button type="button" class="subnav-pill" data-qa-filter="charts" data-act="filterQuickAddCategory" data-act-args="[&quot;charts&quot;,&quot;@self&quot;]">Charts</button>
        <button type="button" class="subnav-pill" data-qa-filter="streaming" data-act="filterQuickAddCategory" data-act-args="[&quot;streaming&quot;,&quot;@self&quot;]">Streaming</button>
        <button type="button" class="subnav-pill" data-qa-filter="genres" data-act="filterQuickAddCategory" data-act-args="[&quot;genres&quot;,&quot;@self&quot;]">Genres</button>
        <button type="button" class="subnav-pill" data-qa-filter="kids" data-act="filterQuickAddCategory" data-act-args="[&quot;kids&quot;,&quot;@self&quot;]">Kids</button>
        <button type="button" class="subnav-pill" data-qa-filter="holidays" data-act="filterQuickAddCategory" data-act-args="[&quot;holidays&quot;,&quot;@self&quot;]">Holidays</button>
      </div>
    </div>

    <!-- Empty search result card -->
    <div id="qaNoResults" style="display:none; text-align:center; padding:36px 16px; color:var(--muted); background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:16px;">
      <p style="margin:0 0 8px; font-weight:600; font-size:0.95rem; color:var(--text);">No matching charts or catalogs found</p>
      <p style="margin:0 0 16px; font-size:0.82rem; color:var(--muted);">Try searching for a different service, genre, or keyword, or clear your filters.</p>
      <button type="button" class="lc-btn secondary" data-act="resetQuickAddFilters">Reset Filters</button>
    </div>

    <div id="catalogsQuickAddContainer">

    <!-- My Lists Addon Charts Shelf -- this add-on's own charts (MY_LISTS_ADDON_CHARTS, 08). -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="charts">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">My Lists Addon Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="mylists-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Our own charts, updated daily: what just arrived on Netflix, Prime Video, Disney+, HBO Max, Hulu, Apple TV+, Paramount+ and Peacock (a show moves back to the top when new episodes land), and what people using My Lists Addon are watching most today, this week and this month:</p>
      ${myListsAddonChartsHtml}
    </div>

    <!-- Combined Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="charts">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Combined Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="combined-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">One row that blends MDBList, TMDB, Trakt and Simkl together and de-duplicates the result, so a title that charts on several of them still appears once:</p>
      ${combinedChartsHtml}
    </div>

    <!-- TMDB Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="charts">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">TMDB Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="tmdb-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">TheMovieDB's own charts &mdash; New Releases, Trending, Popular, Top Rated, Now Playing and Upcoming:</p>
      ${tmdbChartsHtml}
    </div>

    <!-- Trakt Official Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="charts">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Trakt Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="trakt-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Trakt's community charts, straight from its API &mdash; what is trending and most played now, through to the weekly box office:</p>
      ${traktChartsHtml}
    </div>

    <!-- MDBList Official Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="charts">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">MDBList Official</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="mdblist-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">MDBList's official charts, including the JustWatch daily streaming rankings and IMDb's MovieMeter:</p>
      ${mdblistChartsHtml}
    </div>

    <!-- Simkl Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="charts">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Simkl Anime &amp; Trending</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="simkl-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Simkl's daily, weekly and monthly trending windows, plus its anime chart:</p>
      ${simklChartsHtml}
    </div>

    <!-- Streaming Top 10 Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="streaming">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Streaming Top 10</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="streaming-top10">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">What is in each service's current Top 10, as one catalog row per service:</p>
      ${streamingTop10Html}
    </div>

    <!-- Streaming Catalogs Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="streaming">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Streaming Catalogs</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="streaming-catalogs">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">The full catalog of each of the ten streaming services, browsable as its own row:</p>
      ${streamingHtml}
    </div>

    <!-- Kids Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="kids">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Kids</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="kids">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Filtered by certification rather than by genre, so nothing above the rating you pick can appear:</p>
      ${kidsHtml}
    </div>

    <!-- Holidays Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="holidays">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Holidays</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="holidays">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Seasonal rows for Christmas, Halloween, Thanksgiving and the rest of the calendar:</p>
      ${holidaysHtml}
    </div>

    <!-- Genres Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all" data-qa-category="genres">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Genres</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="genres">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">One row per genre, from Family and Fantasy through to War and Western:</p>
      ${genresHtml}
    </div>
  </div>
  </div>
</div>

