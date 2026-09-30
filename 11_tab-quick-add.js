<div class="tab-panel" data-tab-panel="discover" id="content-discover" role="tabpanel" aria-labelledby="tab-desktop-discover">
  <!-- Discover Top Submenu Pills -->
  <div class="subnav-pills-bar" id="discoverSubnavBar">
    <button type="button" class="subnav-pill" data-sub="all" data-act="filterDiscoverShelves" data-act-args="[&quot;all&quot;,&quot;@self&quot;]">All</button>
    <button type="button" class="subnav-pill active" data-sub="movie" data-act="filterDiscoverShelves" data-act-args="[&quot;movie&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> Movies</button>
    <button type="button" class="subnav-pill" data-sub="series" data-act="filterDiscoverShelves" data-act-args="[&quot;series&quot;,&quot;@self&quot;]">Shows</button>
    <button type="button" class="subnav-pill" data-sub="popular" data-act="filterDiscoverShelves" data-act-args="[&quot;popular&quot;,&quot;@self&quot;]">Popular Lists</button>
    <button type="button" class="subnav-pill" data-sub="curated" data-act="filterDiscoverShelves" data-act-args="[&quot;curated&quot;,&quot;@self&quot;]">Curated</button>
    <button type="button" class="subnav-pill" data-sub="gems" data-act="filterDiscoverShelves" data-act-args="[&quot;gems&quot;,&quot;@self&quot;]">Hidden Gems</button>
    <button type="button" class="subnav-pill" data-sub="kids" data-act="filterDiscoverShelves" data-act-args="[&quot;kids&quot;,&quot;@self&quot;]">Kids</button>
    <button type="button" class="subnav-pill" data-sub="holidays" data-act="filterDiscoverShelves" data-act-args="[&quot;holidays&quot;,&quot;@self&quot;]">Holidays</button>
    <button type="button" class="subnav-pill" data-sub="genres" data-act="filterDiscoverShelves" data-act-args="[&quot;genres&quot;,&quot;@self&quot;]">Genres</button>
  </div>

  <!-- The shell's Explore section (P6-5): community lists from this site and
       from MDBList, Trakt and TMDB, with a preview and one button to add one to
       the home screen. Emitted only for a browser with the FF_NEW_UI cookie;
       the Discover feeds below are unchanged. -->
${newUi ? '  <div id="appShellExplore"></div>' : ''}

  <!-- Discover Shelves Feed -->
  <div id="discoverShelvesContainer">
    <!-- My Lists Addon Charts Shelf -->
    ${myListsAddonChartsHtml}

    <!-- Combined Charts Shelf -->
    ${combinedChartsHtml}

    <!-- TMDB Charts Shelf -->
    ${tmdbChartsHtml}

    <!-- Trakt Official Charts Shelf -->
    ${traktChartsHtml}

    <!-- MDBList Official Charts Shelf -->
    ${mdblistChartsHtml}

    <!-- Simkl Charts Shelf -->
    ${simklChartsHtml}

    <!-- Streaming Top 10 Shelf -->
    ${streamingTop10Html}

    <!-- Streaming Catalogs Shelf -->
    ${streamingHtml}

    <!-- Hidden Gems Shelf -->
    ${hiddenGemsHtml}

    <!-- Kids Shelf -->
    ${kidsHtml}

    <!-- Holidays Shelf -->
    ${holidaysHtml}

    <!-- Genres Shelf -->
    ${genresHtml}
  </div>

  <!-- Discover Shared Lists Feed (All / Movies / Shows / Hidden Gems / Kids / Holidays / Genres) -->
  <div class="discover-subpanel" id="discoverSubSharedFeed" style="display:none;">
    <div class="panel">
      <div class="shelf-header" id="discoverListsFeedHeader" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="discoverListsFeedTitle">Movies</h2>
        <button type="button" class="secondary lc-btn" data-act="appActRefreshDiscoverCharts">Refresh</button>
      </div>
      <p id="discoverListsFeedDesc" style="margin:0 0 14px; color:var(--muted); font-size:0.85rem; line-height:1.45;">Top charts, new releases, and popular movie collections across streaming platforms.</p>
      <div id="discoverListsFeed"></div>
    </div>
  </div>

  <!-- Popular Lists Feed in Discover -->
  <div class="discover-subpanel" id="discoverSubPopular" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Popular Community Lists</h2>
        <button type="button" class="secondary lc-btn" data-act="loadPopularListsFeed" data-act-args="[true]">Refresh</button>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem; line-height:1.45;">Top trending and highly-rated community lists shared by creators and viewers.</p>
      <div id="popularListsFeed"></div>
    </div>
  </div>

  <!-- Curated Lists Feed in Discover -->
  <div class="discover-subpanel" id="discoverSubCurated" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Curated For You</h2>
        <button type="button" class="secondary lc-btn" data-act="loadCuratedListsFeed" data-act-args="[true]">Refresh</button>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem; line-height:1.45;">Personalized recommendations and curated lists tailored to your watch history and tastes.</p>
      <div id="curatedListsFeed"></div>
    </div>
  </div>
</div>
