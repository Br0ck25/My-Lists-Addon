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

  <!-- Discover Shelves Feed -->
  <div id="discoverShelvesContainer" style="display:none;">
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
      <div class="shelf-header" id="discoverListsFeedHeader">
        <h2 class="shelf-title sr-only" id="discoverListsFeedTitle">Movies</h2>
        <p id="discoverListsFeedDesc">Top charts, new releases, and popular movie collections across streaming platforms.</p>
        ${refreshButtonHtml('appActRefreshDiscoverCharts', 'Refresh charts')}
      </div>
      <div id="discoverListsFeed"></div>
    </div>
  </div>

  <!-- Popular Lists Feed in Discover -->
  <div class="discover-subpanel" id="discoverSubPopular" style="display:none;">
    <div class="panel">
      <div class="shelf-header">
        <h2 class="shelf-title sr-only">Popular Community Lists</h2>
        <p>Top trending and highly-rated community lists shared by creators and viewers.</p>
        ${refreshButtonHtml('loadPopularListsFeed', 'Refresh popular lists', [true])}
      </div>
      <div id="popularListsFeed"></div>
    </div>
  </div>

  <!-- Curated Lists Feed in Discover -->
  <div class="discover-subpanel" id="discoverSubCurated" style="display:none;">
    <div class="panel">
      <div class="shelf-header">
        <h2 class="shelf-title sr-only">Curated For You</h2>
        <p>Personalized recommendations and curated lists tailored to your watch history and tastes.</p>
        ${refreshButtonHtml('loadCuratedListsFeed', 'Refresh curated recommendations', [true])}
      </div>
      <div id="curatedListsFeed"></div>
    </div>
  </div>
</div>
