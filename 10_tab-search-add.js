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
    <div class="shelf-header u-mb-12px u-ai-center u-jc-space_between u-gap-12px">
      <div>
        <h2 class="shelf-title sr-only">Live Preview &amp; Editor</h2>
        <p class="u-m-0 u-c-v_muted u-fs-v_font_size_sm">Catalogs and lists you've added to your add-on. Reorder, edit, and preview your active shelves.</p>
      </div>
      <div class="actions u-fd-row u-fw2-wrap u-ai-center u-gap-6px u-fsh-0">
        <button type="button" class="primary lc-btn" data-act="openAddShelfModal">+ New Catalog</button>
        <button type="button" class="secondary lc-btn" id="livePreviewEditBtn" data-act="toggleLivePreviewEdit">Edit</button>
        ${refreshButtonHtml('renderLivePreview', 'Refresh catalogs preview')}
      </div>
    </div>

    <div class="row u-mb-12px u-gap-8px">
      <input type="text" id="listFilterInput" aria-label="Filter catalogs by name" placeholder="Filter catalogs by name..." data-act-on="input" data-act="filterLists">
      <select id="listGroupFilterSelect" aria-label="Filter catalogs by group" data-act="filterLists" style="flex:none; width:auto;">
        <option value="">All groups</option>
      </select>
    </div>

    <!-- Reorderable Catalog Shelves -->
    <div id="lists"></div>

    <!-- The shell's "Hide titles already shown in rows above" toggle (P6-3),
         right above the Daily Randomizer. -->
    <div id="appShellHomeEditor"></div>

    <!-- 24-Hour Randomizer Controls -->
    <div class="u-mt-16px u-p-12px_16px u-bg-v_surface u-br-v_radius_md u-bd-1px_solid_v_border">
      <div style="font-weight:600; font-size:var(--font-size-base); margin-bottom:4px; display:flex; align-items:center; gap:6px;">
        <span>Daily Randomizer</span>
      </div>
      <div>
        <div class="settings-toggle-row">
          <div class="u-flex-1 u-minw-0 u-pr-12px">
            <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Shuffle Catalogs daily (every 24h)</span>
            <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Rotates the order of your catalog rows once every 24 hours.</p>
          </div>
          <label class="ui-toggle" aria-label="Shuffle Catalogs daily (every 24h)">
            <input type="checkbox" id="shuffleShelvesCheckbox" data-act="saveState">
            <span class="ui-toggle-slider"></span>
          </label>
        </div>

        <div class="settings-toggle-row">
          <div class="u-flex-1 u-minw-0 u-pr-12px">
            <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Shuffle items in Catalogs daily (every 24h)</span>
            <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Randomizes the order of titles inside each catalog row every 24 hours.</p>
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

  <!-- Generated Install Link Result Box -->
  <div id="result"></div>

    </div>
  
  <div class="lists-subpanel" id="catalogsSubBulk" style="display:none;">
  <div class="panel bulk-panel">
    <h2 class="panel-title">Bulk Import Lists</h2>
    <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm u-lh-1_45">Paste multiple list URLs at once, one per line. Each list is automatically detected and added to your catalogs.</p>
    <div class="bulk-provider-badges">
      <span class="bulk-provider-label">Supported:</span>
      <span class="list-source-badge badge-mdblist">MDBList</span>
      <span class="list-source-badge badge-trakt">Trakt</span>
      <span class="list-source-badge badge-tmdb">TMDB</span>
      <span class="list-source-badge badge-simkl">Simkl</span>
      <span class="list-source-badge badge-imdb">IMDb</span>
    </div>
    <textarea id="bulkPasteBox" rows="6" data-act-on="input" data-act="updateBulkAddUi" placeholder="https://mdblist.com/lists/user/list-one&#10;https://trakt.tv/users/user/lists/list-two&#10;https://www.themoviedb.org/list/12345"></textarea>
    <div class="bulk-actions-bar">
      <div class="bulk-actions-left">
        <button type="button" id="bulkAddBtn" class="primary" data-act="bulkAddLists" data-act-args="[&quot;@self&quot;]">Add All Lines as Catalogs</button>
        <button type="button" id="bulkClearBtn" class="secondary" data-act="clearBulkInput" style="display:none;">Clear</button>
      </div>
      <div id="bulkDetectedCount"></div>
    </div>
  </div>
  </div>

  <div class="lists-subpanel" id="catalogsSubQuickAdd" style="display:none;">
    <div id="catalogsQuickAddContainer">

    <!-- My Lists Addon Charts Shelf -- this add-on's own charts (MY_LISTS_ADDON_CHARTS, 08). -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">My Lists Addon Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="mylists-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Our own charts, updated daily: what just arrived on Netflix, Prime Video, Disney+, HBO Max, Hulu, Apple TV+, Paramount+ and Peacock (a show moves back to the top when new episodes land), and what people using My Lists Addon are watching most today, this week and this month:</p>
      ${myListsAddonChartsHtml}
    </div>

    <!-- Combined Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Combined Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="combined-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">One row that blends MDBList, TMDB, Trakt and Simkl together and de-duplicates the result, so a title that charts on several of them still appears once:</p>
      ${combinedChartsHtml}
    </div>

    <!-- TMDB Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">TMDB Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="tmdb-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">TheMovieDB's own charts &mdash; New Releases, Trending, Popular, Top Rated, Now Playing and Upcoming:</p>
      ${tmdbChartsHtml}
    </div>

    <!-- Trakt Official Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Trakt Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="trakt-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Trakt's community charts, straight from its API &mdash; what is trending and most played now, through to the weekly box office:</p>
      ${traktChartsHtml}
    </div>

    <!-- MDBList Official Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">MDBList Official</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="mdblist-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">MDBList's official charts, including the JustWatch daily streaming rankings and IMDb's MovieMeter:</p>
      ${mdblistChartsHtml}
    </div>

    <!-- Simkl Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Simkl Anime &amp; Trending</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="simkl-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Simkl's daily, weekly and monthly trending windows, plus its anime chart:</p>
      ${simklChartsHtml}
    </div>

    <!-- Streaming Top 10 Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Streaming Top 10</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="streaming-top10">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">What is in each service's current Top 10, as one catalog row per service:</p>
      ${streamingTop10Html}
    </div>

    <!-- Streaming Catalogs Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Streaming Catalogs</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="streaming-catalogs">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">The full catalog of each of the ten streaming services, browsable as its own row:</p>
      ${streamingHtml}
    </div>

    <!-- Kids Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Kids</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="kids">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Filtered by certification rather than by genre, so nothing above the rating you pick can appear:</p>
      ${kidsHtml}
    </div>

    <!-- Holidays Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Holidays</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="holidays">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Seasonal rows for Christmas, Halloween, Thanksgiving and the rest of the calendar:</p>
      ${holidaysHtml}
    </div>

    <!-- Genres Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Genres</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="genres">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">One row per genre, from Family and Fantasy through to War and Western:</p>
      ${genresHtml}
    </div>
  </div>
  </div>
</div>

