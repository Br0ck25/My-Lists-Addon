<div class="tab-panel" data-tab-panel="channels" id="content-channels" role="tabpanel" aria-labelledby="tab-desktop-channels" hidden>
  <!-- Top Submenu Pills for Channels -->
  <div class="subnav-pills-bar" id="channelsSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="my-channels" data-act="switchChannelsSubmenu" data-act-args="[&quot;my-channels&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> My Channels</button>
    <button type="button" class="subnav-pill" data-sub="storylines" data-act="switchChannelsSubmenu" data-act-args="[&quot;storylines&quot;,&quot;@self&quot;]">Storylines &amp; Universes</button>
    <button type="button" class="subnav-pill" data-sub="quickadd" data-act="switchChannelsSubmenu" data-act-args="[&quot;quickadd&quot;,&quot;@self&quot;]">Quick Add</button>
    <button type="button" class="subnav-pill" data-sub="explore" data-act="switchChannelsSubmenu" data-act-args="[&quot;explore&quot;,&quot;@self&quot;]">Explore Channels</button>
    <button type="button" class="subnav-pill" data-sub="import" data-act="switchChannelsSubmenu" data-act-args="[&quot;import&quot;,&quot;@self&quot;]" style="display:none;">Import</button>
  </div>

  <!-- Submenu: Storylines & Universes (Canon Timelines, Sagas & Bridges) -->
  <div class="channels-subpanel" id="channelsSubStorylines" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title sr-only">Storylines, Sagas &amp; Universes</h2>
        <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm u-lh-1_4">
          Complete franchise timelines, movie trilogies &amp; sagas (3+ films), and TV-to-movie universes in canon chronological watch order. Add any saga directly to your Catalogs or launch it as a continuous 24/7 channel with 1-click.
        </p>
      </div>

      <!-- Category Filter Tabs -->
      <div class="subnav-pills-bar u-mb-16px" id="storylineCategoryFilterBar">
        <button type="button" class="subnav-pill active" data-act="filterStorylinesCategory" data-act-args="[&quot;all&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> All Sagas</button>
        <button type="button" class="subnav-pill" data-act="filterStorylinesCategory" data-act-args="[&quot;moviesagas&quot;,&quot;@self&quot;]">Movie Sagas (3+ Films)</button>
        <button type="button" class="subnav-pill" data-act="filterStorylinesCategory" data-act-args="[&quot;tvuniverses&quot;,&quot;@self&quot;]">TV Universes &amp; Bridges</button>
        <button type="button" class="subnav-pill" data-act="filterStorylinesCategory" data-act-args="[&quot;scifi&quot;,&quot;@self&quot;]">Sci-Fi &amp; Fantasy</button>
        <button type="button" class="subnav-pill" data-act="filterStorylinesCategory" data-act-args="[&quot;action&quot;,&quot;@self&quot;]">Action &amp; Crime</button>
        <button type="button" class="subnav-pill" data-act="filterStorylinesCategory" data-act-args="[&quot;animation&quot;,&quot;@self&quot;]">Animation &amp; Anime</button>
      </div>

      <div id="storylinesUniverseList" class="u-fd-column u-gap-16px" style="display:flex;"></div>
    </div>
  </div>

  <!-- Submenu 1: My Channels -->
  <div class="channels-subpanel" id="channelsSubMyChannels">
    <div class="panel">
      <div class="shelf-header u-mb-10px u-ai-center u-jc-space_between u-gap-12px">
        <div>
          <h2 class="shelf-title sr-only">My Channels</h2>
          <p class="u-m-0 u-c-v_muted u-fs-v_font_size_sm">Your custom built and saved 24/7 TV channels. Play episodes continuously in broadcast order or daily shuffle.</p>
        </div>
        <div class="u-gap-8px u-fw2-wrap u-ai-center" style="display:flex;">
          <button type="button" class="secondary lc-btn" data-act="createNextUpChannel" data-act-args="[&quot;@self&quot;]" title="A channel that always plays the next episode of everything you have on the go">+ Next Up Channel</button>
          <button type="button" class="primary lc-btn" data-act="openBuildCustomChannel">+ Create Channel</button>
          <button type="button" class="secondary lc-btn" data-act="openImportChannelModal" title="Import channel from link or share code">Import</button>
          ${refreshButtonHtml('refreshMyChannelsAction', 'Refresh channels')}
        </div>
      </div>
      <div id="channelNextUpStatus" class="u-mb-8px"></div>
      <div class="row u-mb-10px u-gap-8px" id="myChannelsToolbar">
        <div class="search-input-box u-flex-1">
          <svg class="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="myChannelsSearchInput" aria-label="Search your channels" placeholder="Search your channels..." class="u-pl-38px u-br-v_radius_pill" data-act-on="input" data-act="setMyChannelsSearch" data-act-args="[&quot;@value&quot;]">
        </div>
        <select id="myChannelsSortSelect" aria-label="Order your channels" data-act="setMyChannelsSort" data-act-args="[&quot;@value&quot;]" class="u-flex-none u-br-v_radius_pill" style="width:auto;">
          <option value="recent">Recently updated</option>
          <option value="created">Recently created</option>
          <option value="name">Name (A&ndash;Z)</option>
          <option value="size">Most episodes</option>
          <option value="manual">My order (drag to arrange)</option>
        </select>
      </div>
      <div id="myChannelsUndoBar" class="u-mb-10px" style="display:none;"></div>
      <div id="myCreatedChannelsList"><p class="u-c-v_muted u-fs-v_font_size_sm"><small>No channels created yet. Tap <strong>+ Create Channel</strong> above or add a popular network in <strong>Quick Add</strong>.</small></p></div>
    </div>

    <div class="panel u-mt-12px">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Merge Saved Channels into One Catalog</h2>
      </div>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Combine multiple saved TV channels. <strong>Merge into catalog</strong> puts them in one catalog row and keeps each channel separate. <strong>Combine into one channel</strong> makes a new channel with all of their episodes, counting an episode that is in more than one of them once.</p>
      
      <div id="savedMergedChannelsSection" class="u-mb-16px">
        <div id="savedMergedChannelsList"></div>
      </div>

      <div class="u-bdt-1px_solid_v_border u-pt-12px u-mt-12px">
        <div class="shelf-header u-mb-8px">
          <h3 class="u-fs-v_font_size_base u-fw-700 u-m-0">Create Merged Catalog or Channel</h3>
        </div>
        <div id="channelMergeSelectAllWrap" class="actions u-mb-8px u-jc-flex_end" style="display:none;">
          <label class="u-ai-center u-gap-6px u-cur-pointer u-fs-v_font_size_sm u-us-none" style="display:flex;">
            <input type="checkbox" id="channelMergeSelectAllCheck" data-act="toggleAllChannelMergeChecks" data-act-args="[&quot;@self&quot;]">
            <span>Select all</span>
          </label>
        </div>
        <div id="channelMergeList"><p class="u-c-v_muted u-fs-v_font_size_sm"><small>No saved channels yet.</small></p></div>
        <div class="row u-mt-10px u-gap-8px" id="channelMergeControls" style="display:none;">
          <input type="text" id="channelMergeNameInput" aria-label="Combined catalog or channel name" placeholder="Combined name (e.g. Live TV)" class="u-maxw-380px u-br-v_radius_pill" style="width:100%;">
          <button type="button" class="secondary lc-btn u-br-v_radius_pill" data-act="mergeChannelsIntoRow">Merge into catalog</button>
          <button type="button" class="secondary lc-btn u-br-v_radius_pill" data-act="combineChannelsIntoChannel" data-act-args="[&quot;@self&quot;]" title="Make a new channel with every episode of the checked channels, duplicates left out">Combine into one channel</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Submenu 2: Quick Add Popular Networks -->
  <div class="channels-subpanel" id="channelsSubQuickAdd" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title sr-only">Quick Add Popular Networks</h2>
      </div>
      <p class="qa-shelf-sub">Instant 1-click TV channels with up to 5,000 episodes, rotating 24 shows with 3 episodes every 24 hours:</p>
      <div class="channel-quick-sections u-fd-column u-gap-16px u-mt-14px" style="display:flex;">
        <div>
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_muted u-tt-uppercase u-ls-0_05em u-mb-8px">Major Broadcast</div>
          <div class="channel-quick-grid">
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="ABC" data-networkid="2">ABC</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="CBS" data-networkid="16">CBS</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FOX" data-networkid="19">FOX</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="NBC" data-networkid="6">NBC</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="The CW" data-networkid="71">The CW</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="BBC One" data-networkid="4">BBC One</button>
          </div>
        </div>

        <div>
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_muted u-tt-uppercase u-ls-0_05em u-mb-8px">Cable &amp; Premium Drama</div>
          <div class="channel-quick-grid">
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="AMC" data-networkid="174">AMC</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Comedy Central" data-networkid="47">Comedy Central</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FX" data-networkid="88">FX</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="HBO" data-networkid="49">HBO</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Syfy" data-networkid="149">Syfy</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="TBS" data-networkid="68">TBS</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="TNT" data-networkid="41">TNT</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="USA Network" data-networkid="30">USA Network</button>
          </div>
        </div>

        <div>
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_muted u-tt-uppercase u-ls-0_05em u-mb-8px">Animation &amp; Kids</div>
          <div class="channel-quick-grid">
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Adult Swim" data-networkid="80">Adult Swim</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Cartoon Network" data-networkid="56">Cartoon Network</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Disney Channel" data-networkid="54">Disney Channel</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Nickelodeon" data-networkid="13">Nickelodeon</button>
          </div>
        </div>

        <div>
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_muted u-tt-uppercase u-ls-0_05em u-mb-8px">Documentary &amp; Lifestyle</div>
          <div class="channel-quick-grid">
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Discovery" data-networkid="64">Discovery</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Food Network" data-networkid="143">Food Network</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="HGTV" data-networkid="209">HGTV</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="History" data-networkid="65">History</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="TLC" data-networkid="84">TLC</button>
          </div>
        </div>

        <div>
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_muted u-tt-uppercase u-ls-0_05em u-mb-8px">Classics &amp; Variety</div>
          <div class="channel-quick-grid">
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="A&amp;E" data-networkid="129">A&amp;E</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Hallmark Channel" data-networkid="384">Hallmark Channel</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Ion Television" data-networkid="436">Ion Television</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="MeTV" data-networkid="738">MeTV</button>
            <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="MTV" data-networkid="33">MTV</button>
          </div>
        </div>
      </div>
      <div id="channelQuickAddStatus" class="u-mt-8px"></div>
    </div>
  </div>

  <!-- Submenu: Explore Channels (the community directory) -->
  <div class="channels-subpanel" id="channelsSubExplore" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title sr-only">Explore Channels</h2>
        <p class="u-m-0 u-c-v_muted u-fs-v_font_size_sm">
          24/7 channels built and published by other people &mdash; &ldquo;Saturday Morning 90s&rdquo;, &ldquo;80s VHS Sci-Fi Vault&rdquo;, whatever anyone has put together. Add one to your own setup in a single click, then edit it however you like.
        </p>
      </div>
      <div class="row u-mb-10px u-gap-8px u-ai-center">
        <div class="search-input-box u-flex-1">
          <svg class="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="channelDirectorySearchInput" aria-label="Filter published channels" placeholder="Filter by name, description or creator..." class="u-pl-38px u-br-v_radius_pill" data-act-on="input" data-act="renderChannelDirectory">
        </div>
        <select id="channelDirectorySortSelect" aria-label="Order published channels" data-act="setChannelDirectorySort" data-act-args="[&quot;@value&quot;]" class="u-flex-none u-br-v_radius_pill" style="width:auto;">
          <option value="newest">Newest</option>
          <option value="added">Most added</option>
          <option value="liked">Most liked</option>
          <option value="name">Name (A&ndash;Z)</option>
        </select>
        ${refreshButtonHtml('loadChannelDirectory', 'Refresh published channels', [true])}
      </div>
      <div id="channelDirectoryFeed"><p class="u-c-v_muted u-fs-v_font_size_sm"><small>Loading published channels&hellip;</small></p></div>
    </div>
  </div>

  <!-- Submenu 3: Import & Merge Tools -->
  <div class="channels-subpanel" id="channelsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Import channel from a link</h2>
      </div>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Paste any MDBList, Trakt, or TMDB show list URL to import directly as a TV channel catalog.</p>
      <div class="row u-mb-8px">
        <input type="text" id="channelImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org show list URL">
      </div>
      <div class="row">
        <input type="text" id="channelImportNameInput" placeholder="Channel name (e.g. Sitcom Central)">
        <button type="button" class="secondary" data-act="importChannelFromLink" data-act-args="[&quot;@self&quot;]">Import channel</button>
      </div>
      <label class="channel-rule-row u-mt-10px">
        <input type="checkbox" id="channelImportLiveSyncCheck" checked>
        <span>Live Cloud Sync &mdash; keep this channel following the list instead of taking a one-time snapshot</span>
      </label>
      <p class="u-m-2px_0_0_24px u-c-v_muted u-fs-v_font_size_xs">The channel remembers the list URL and rebuilds its pool in the background, so titles the list gains turn up here on their own.</p>
    </div>

    <div class="panel u-mt-12px">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Add a shared channel</h2>
      </div>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Paste a channel share link (or just its code) to rebuild that exact channel here &mdash; every pick, its play order and its broadcast schedule.</p>
      <div class="row">
        <input type="text" id="channelShareCodeInput" placeholder="https://... /channel/AbC123 &mdash; or the code on its own" data-act-on="keydown" data-act="importSharedChannel" data-act-keys="Enter" data-act-prevent data-act-args="[&quot;@self&quot;]">
        <button type="button" class="secondary" data-act="importSharedChannel" data-act-args="[&quot;@self&quot;]">Add channel</button>
      </div>
      <div id="channelShareImportStatus" class="u-mt-8px"></div>
    </div>
  </div>

  <!-- Custom Channel Builder / Editor -->
  <div class="channels-subpanel" id="channelsSubBuild" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-10px">
        <h2 class="shelf-title" id="channelEditorTitle">Create a Custom Channel</h2>
      </div>
      <p class="u-m-0_0_16px u-c-v_muted u-fs-v_font_size_sm">Curate, reorder, and manage picks for this custom channel.</p>

      <!-- 1. Channel Name -->
      <div class="u-mb-16px u-maxw-480px">
        <label for="channelNameInput" class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-6px" style="display:block;">Channel Name</label>
        <input type="text" id="channelNameInput" placeholder="Channel name (e.g. Comedy Night)">
      </div>

      <!-- 2. Public Channel Toggle -->
      <div id="channelVisibilityRow" class="u-p-10px_14px u-bg-v_surface u-bd-1px_solid_v_border u-br-v_radius_md u-jc-space_between u-ai-center u-gap-12px u-mb-16px" style="display:flex;">
        <div>
          <span class="u-fs-v_font_size_sm u-fw-600 u-c-v_text">Public Channel</span>
          <p class="u-m-2px_0_0 u-fs-v_font_size_xs u-c-v_muted">Make this channel visible on your public creator profile and discoverable in the community directory</p>
        </div>
        <label class="ui-toggle" aria-label="Make channel public">
          <input type="checkbox" id="channelPublicToggle" checked>
          <span class="ui-toggle-slider"></span>
        </label>
      </div>

      <!-- 3. Search & Add Titles -->
      <div class="custom-list-search-section u-bd-1px_solid_v_border u-br-v_radius_md u-p-16px u-bg-v_surface u-mb-16px u-bsh-v_shadow_sm">
        <label for="channelSearchInput" class="u-fs-v_font_size_sm u-fw-700 u-c-v_text u-mb-4px" style="display:block;">Add Titles to Channel</label>
        <p class="u-m-0_0_10px u-fs-v_font_size_sm u-c-v_muted">Search any TV show or movie to add to your channel.</p>
      <div class="subnav-pills-bar u-mb-10px" id="channelSearchTypeChips">
        <button type="button" class="subnav-pill active" id="channelSearchTypeShowsBtn" data-act="setChannelSearchType" data-act-args="[&quot;tv&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> Shows</button>
        <button type="button" class="subnav-pill" id="channelSearchTypeMoviesBtn" data-act="setChannelSearchType" data-act-args="[&quot;movie&quot;,&quot;@self&quot;]">Movies</button>
        <button type="button" class="subnav-pill" id="channelSearchTypePeopleBtn" data-act="setChannelSearchType" data-act-args="[&quot;person&quot;,&quot;@self&quot;]">Actors &amp; Directors</button>
      </div>
      <div class="row u-gap-8px">
        <div class="search-input-box u-flex-1">
          <svg class="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="channelSearchInput" placeholder="Search a show by name..." data-act-on="keydown" data-act="runChannelTitleSearch" data-act-keys="Enter" data-act-prevent>
        </div>
        <button type="button" class="secondary lc-btn" data-act="runChannelTitleSearch">Search</button>
      </div>
      <div id="channelSearchResult"></div>
      <div id="channelEpisodePicker"></div>

      <div id="channelCrossoverSuggestions" class="u-mt-14px" style="display:none;"></div>
      </div>

      <p class="u-mt-14px u-mb-6px u-fw-600 u-fs-v_font_size_sm">Picks in this channel: <span id="channelDraftCountBadge" class="u-c-v_muted u-fw-500"></span></p>
      <div id="channelDraftStats" class="u-m-0_0_8px u-c-v_muted u-fs-v_font_size_xs"></div>
      <div class="row u-mb-8px u-gap-8px">
        <div class="search-input-box u-flex-1">
          <svg class="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="channelDraftFilterInput" aria-label="Filter these picks" placeholder="Filter these picks by show or episode name..." data-act-on="input" data-act="setChannelDraftFilter" data-act-args="[&quot;@value&quot;]">
        </div>
        <button type="button" class="secondary lc-btn u-flex-none u-ws-nowrap" id="channelDraftSelectModeBtn" style="width:auto;" data-act="toggleChannelDraftSelectMode">Select</button>
      </div>
      <div id="channelDraftBulkBar" class="u-fw2-wrap u-gap-6px u-ai-center u-mb-8px u-p-8px u-bd-1px_solid_v_border u-br-v_radius_sm u-bg-v_surface" style="display:none;">
        <span id="channelDraftSelectionCount" class="u-fs-v_font_size_sm u-fw-600">0 selected</span>
        <button type="button" class="secondary lc-btn" data-act="selectAllChannelDraftShown" data-act-args="[true]">Select shown</button>
        <button type="button" class="secondary lc-btn" data-act="selectAllChannelDraftShown" data-act-args="[false]">Clear</button>
        <select id="channelDraftSelectShowSelect" data-act="appActSelectChannelDraftGroup" data-act-args="[&quot;@self&quot;,&quot;@value&quot;]" class="u-fs-v_font_size_sm u-p-5px_8px u-bg-v_bg u-c-v_text u-bd-1px_solid_v_border u-br-v_radius_sm">
          <option value="">Select a whole show or season&hellip;</option>
        </select>
        <span class="u-flex-1"></span>
        <button type="button" class="secondary lc-btn" data-act="pairChannelDraftSelection" title="Play these picks back to back, in this order">Pair</button>
        <button type="button" class="secondary lc-btn" data-act="unpairChannelDraftSelection" title="Drop any hand-made pairing on these picks">Unpair</button>
        <button type="button" class="secondary lc-btn" data-act="moveChannelDraftSelection" data-act-args="[&quot;top&quot;]">To top</button>
        <button type="button" class="secondary lc-btn" data-act="moveChannelDraftSelection" data-act-args="[&quot;bottom&quot;]">To bottom</button>
        <button type="button" class="secondary lc-btn u-c-v_danger u-bdc-rgba_255_59_48_0_25" data-act="removeChannelDraftSelection">Remove selected</button>
      </div>
      <div id="channelDraftList"><p class="u-c-v_muted u-fs-v_font_size_sm"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
      <div class="actions u-mt-8px u-jc-flex_start u-gap-8px">
        <button type="button" class="secondary lc-btn" data-act="appActShuffleChannelPicks">Shuffle Picks Now</button>
        <button type="button" class="secondary lc-btn u-c-v_danger u-bdc-rgba_255_59_48_0_25" data-act="removeAllChannelDraftPicks">Remove All</button>
      </div>
      <!-- Advanced Settings (Progressive Disclosure) -->
      <details class="channel-advanced-details u-mt-14px u-bd-1px_solid_v_border u-br-v_radius_sm u-p-10px_14px u-bg-v_surface">
        <summary class="u-fw-600 u-fs-v_font_size_sm u-cur-pointer u-us-none u-c-v_text u-ai-center u-jc-space_between" style="display:flex;">
          <span>Advanced Settings</span>
          <span class="u-fs-v_font_size_xs u-c-v_muted u-fw-normal">Play order, rotation &amp; broadcast schedule</span>
        </summary>
        <div class="u-mt-14px u-bdt-1px_solid_v_border u-pt-12px">
          <div class="u-ai-center u-gap-8px u-mb-6px u-fw2-wrap" style="display:flex;">
            <label for="channelPlayOrderSelect" class="u-fs-v_font_size_sm u-fw-600 u-ws-nowrap">Play order:</label>
            <select id="channelPlayOrderSelect" data-act="applyChannelPlayOrder" data-act-args="[&quot;@value&quot;]" class="u-flex-1 u-minw-210px u-fs-v_font_size_sm u-p-6px_10px u-bg-v_surface u-c-v_text u-bd-1px_solid_v_border u-br-v_radius_sm">
              <option value="as-listed">Creation order (as listed)</option>
              <option value="aired-asc">Air date &mdash; oldest first</option>
              <option value="aired-desc">Air date &mdash; newest first</option>
              <option value="show-season-episode">Show, then season &amp; episode</option>
              <option value="interleave">Interleaved &mdash; one episode per show, in turn</option>
              <option value="title-az">Title A&ndash;Z</option>
              <option value="shuffle-daily">Shuffle daily (reshuffles every 24h)</option>
            </select>
          </div>
          <p id="channelPlayOrderHint" class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_xs">Picks play in the order you created above &mdash; drag one, or type a new position, to change it.</p>

          <!-- Broadcast schedule & smart rules -->
          <div class="u-bdt-1px_solid_v_border u-pt-12px">
            <p class="u-m-0_0_8px u-fw-600 u-fs-v_font_size_sm">Broadcast schedule</p>
            <label class="channel-rule-row">
              <input type="checkbox" id="channelDailyRotateCheck" data-act="updateChannelBroadcastControls">
              <span>Daily Broadcast Schedule &mdash; run a fresh lineup out of these picks every day</span>
            </label>
            <div id="channelDailyRotateDials" class="u-m-8px_0_0_24px u-fw2-wrap u-gap-10px" style="display:none;">
              <label class="channel-dial">Shows per day
                <input type="number" id="channelRotateShowsInput" min="1" max="48" step="1" value="24" data-act="updateChannelBroadcastControls">
              </label>
              <label class="channel-dial">Episodes per block
                <input type="number" id="channelRotateEpisodesInput" min="1" max="12" step="1" value="3" data-act="updateChannelBroadcastControls">
              </label>
              <label class="channel-dial">Turns over at
                <input type="time" id="channelRotateTurnoverTime" value="00:00" data-act="updateChannelBroadcastControls">
              </label>
              <label class="channel-dial">In
                <select id="channelRotateTurnoverZone" data-act="updateChannelBroadcastControls">
                  <option value="utc">UTC</option>
                  <option value="local">my local time</option>
                </select>
              </label>
            </div>
            <p id="channelDailyRotateHint" class="u-m-6px_0_0_24px u-c-v_muted u-fs-v_font_size_xs">Off &mdash; every pick in this channel plays, in the order above.</p>

            <label class="channel-rule-row u-mt-10px">
              <input type="checkbox" id="channelHideWatchedCheck">
              <span>Hide watched &mdash; skip episodes already in my watch history</span>
            </label>
            <p class="u-m-2px_0_0_24px u-c-v_muted u-fs-v_font_size_xs">Needs Auto-track playback signed in. Once every pick has been seen, the whole channel comes back rather than going dark. Leave it off to keep watched episodes in the rotation.</p>

            <label class="channel-rule-row u-mt-10px">
              <input type="checkbox" id="channelPairPartsCheck" data-act="updateChannelBroadcastControls">
              <span>Keep multi-part episodes together</span>
            </label>
            <p id="channelPairPartsHint" class="u-m-2px_0_0_24px u-c-v_muted u-fs-v_font_size_xs">Finds &ldquo;Part 1&rdquo; / &ldquo;Pt. II&rdquo; / &ldquo;(2)&rdquo; in episode titles. Whenever one part is on today, the rest play straight after it instead of turning up tomorrow.</p>

            <label class="channel-rule-row u-mt-10px">
              <input type="checkbox" id="channelAutoNewEpisodesCheck" data-act="updateChannelBroadcastControls">
              <span>Automatically add new episodes</span>
            </label>
            <div id="channelNewEpisodesRow" class="u-m-6px_0_0_24px" style="display:none;">
              <label class="channel-rule-row">
                <input type="checkbox" id="channelNewEpisodesTopCheck">
                <span>Put new episodes at the top</span>
              </label>
            </div>
            <p id="channelAutoNewEpisodesHint" class="u-m-2px_0_0_24px u-c-v_muted u-fs-v_font_size_xs">Off &mdash; this channel plays the picks below and nothing else.</p>

            <div id="channelLiveSyncRow" class="u-mt-10px" style="display:none;">
              <label class="channel-rule-row">
                <input type="checkbox" id="channelLiveSyncCheck">
                <span>Live Cloud Sync &mdash; refresh this channel from its source list</span>
              </label>
              <p id="channelLiveSyncHint" class="u-m-2px_0_0_24px u-c-v_muted u-fs-v_font_size_xs"></p>
            </div>

            <div id="channelStoryLockSection" class="u-mt-12px"></div>
          </div>
        </div>
      </details>

      <!-- Channel Poster Selection Section -->
      <div id="channelPosterPickerSection" class="u-mt-14px u-bdt-1px_solid_v_border u-pt-12px" style="display:none;">
        <p class="u-m-0_0_4px u-fw-600 u-fs-v_font_size_sm">Channel Poster:</p>
        <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Choose a show poster (ranked by most episodes) or choose our custom channel poster.</p>
        <div id="channelPosterChoicesGrid" class="u-gtc-repeat_auto_fill_minmax_90px_1fr u-gap-10px" style="display:grid;"></div>
        <div class="u-mt-12px">
          <p class="u-m-0_0_6px u-fs-v_font_size_sm u-fw-600 u-c-v_muted">Or use a custom image URL (JPEG, PNG, WebP, GIF):</p>
          <div class="row u-gap-8px">
            <input type="url" id="channelPosterUrlInput" placeholder="https://example.com/poster.jpg" class="u-flex-1 u-fs-v_font_size_sm">
            <button type="button" class="secondary u-ws-nowrap u-fs-v_font_size_sm" data-act="applyChannelPosterUrl">Use This</button>
          </div>
          <div id="channelPosterUrlPreview" class="u-mt-8px u-ai-center u-gap-10px" style="display:none;">
            <img id="channelPosterUrlImg" src="" alt="Poster preview" class="u-objectfit-cover u-br-v_radius_xs u-bd-2px_solid_v_accent" style="width:54px; height:80px;" loading="lazy">
            <span id="channelPosterUrlStatus" class="u-fs-v_font_size_xs u-c-v_muted"></span>
          </div>
        </div>
      </div>

      <!-- Bottom Action Bar -->
      <div class="actions u-mt-18px u-bdt-1px_solid_v_border u-pt-14px u-jc-flex_end u-gap-10px">
        <button type="button" id="channelCancelEditBtn" class="secondary lc-btn" style="display:none;" data-act="cancelEditChannel">Cancel</button>
        <button type="button" class="primary lc-btn u-p-8px_24px u-fw-600" id="channelSaveBtn" data-act="saveChannel">Create Channel</button>
      </div>
    </div>
  </div>
</div>

<div class="tab-panel" data-tab-panel="search" id="content-search" role="tabpanel" aria-labelledby="tab-desktop-search" hidden>
  <div class="panel">
    <div class="shelf-header u-mb-12px">
      <h2 class="shelf-title">Search Movies, TV Shows &amp; Lists</h2>
    </div>
    
    <div class="search-input-wrapper">
      <div class="search-input-box">
        <svg class="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input type="text" id="catalogSearchInput" aria-label="Search by title or list name" placeholder="Search movies by title..." class="u-pl-38px u-pr-38px" style="width:100%;" data-act="appActCatalogSearchInput" data-act-on="input,keydown" data-act-args="[&quot;@self&quot;,&quot;@event&quot;]">
        <button type="button" id="catalogSearchClearBtn" class="search-clear-btn" aria-label="Clear search" data-act="clearCatalogSearch">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true" style="pointer-events:none; display:block;"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clip-rule="evenodd" /></svg>
        </button>
      </div>
    </div>

    <div class="search-filters-toolbar">
      <div class="subnav-pills-bar u-m-0 u-p-0 u-fsh-0" id="catalogSearchTypeChips" style="width:auto;">
        <button type="button" class="subnav-pill active" data-act="setCatalogSearchFilter" data-act-args="[&quot;movie&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> Movies</button>
        <button type="button" class="subnav-pill" data-act="setCatalogSearchFilter" data-act-args="[&quot;tv&quot;,&quot;@self&quot;]">Shows</button>
        <button type="button" class="subnav-pill" data-act="setCatalogSearchFilter" data-act-args="[&quot;lists&quot;,&quot;@self&quot;]">Lists</button>
      </div>

      <!-- Quick Filter Dropdowns for Movies & Shows -->
      <div id="catalogSearchFiltersRow" class="u-fw2-wrap u-gap-8px u-m-0 u-ai-center" style="display:flex;">
        <select id="catalogSearchGenreSelect" class="search-filter-select" aria-label="Filter by genre" data-act="applySearchFilters">
          <option value="">All Genres</option>
          <option value="28,10759">Action &amp; Adventure</option>
          <option value="16">Animation</option>
          <option value="35">Comedy</option>
          <option value="80">Crime</option>
          <option value="99">Documentary</option>
          <option value="18">Drama</option>
          <option value="10751,10762">Family &amp; Kids</option>
          <option value="14,878,10765">Fantasy &amp; Sci-Fi</option>
          <option value="36">History</option>
          <option value="27">Horror</option>
          <option value="10402">Music</option>
          <option value="9648">Mystery</option>
          <option value="10749">Romance</option>
          <option value="53">Thriller</option>
          <option value="10752,10768">War &amp; Politics</option>
          <option value="37">Western</option>
        </select>

        <select id="catalogSearchYearSelect" class="search-filter-select" aria-label="Filter by year" data-act="applySearchFilters">
          <option value="">All Years</option>
          <option value="2026">2026</option>
          <option value="2025">2025</option>
          <option value="2024">2024</option>
          <option value="2023">2023</option>
          <option value="2020-2022">2020–2022</option>
          <option value="2010-2019">2010s</option>
          <option value="2000-2009">2000s</option>
          <option value="1990-1999">1990s</option>
          <option value="<1990">1980s &amp; Older</option>
        </select>

        <select id="catalogSearchRatingSelect" class="search-filter-select" aria-label="Filter by minimum rating" data-act="applySearchFilters">
          <option value="">All Ratings</option>
          <option value="8.0">8.0+ ⭐</option>
          <option value="7.0">7.0+ ⭐</option>
          <option value="6.0">6.0+ ⭐</option>
          <option value="5.0">5.0+ ⭐</option>
        </select>

        <button type="button" id="catalogSearchResetFiltersBtn" class="secondary lc-btn u-fs-v_font_size_sm u-p-4px_10px u-minh-30px u-br-v_radius_pill" data-act="resetSearchFilters" style="height:30px; display:none;">Reset</button>
      </div>
    </div>
    <!-- Where the lists come from, and in what order: the chips
         Discover's Explore section had, on Search's own list results. See
         setCatalogListSearchChip (19_client-search-and-likes.js). -->
    <div id="catalogListSearchChips" class="catalog-list-chips" style="display:none;">
      <div class="catalog-list-chip-row" role="group" aria-label="Where the lists come from">
        <button type="button" class="catalog-list-chip active" data-chip-kind="source" data-chip-value="all" aria-pressed="true" data-act="setCatalogListSearchChip" data-act-args="[&quot;source&quot;,&quot;all&quot;]">All sources</button>
        <button type="button" class="catalog-list-chip" data-chip-kind="source" data-chip-value="mylists" aria-pressed="false" data-act="setCatalogListSearchChip" data-act-args="[&quot;source&quot;,&quot;mylists&quot;]">My Lists Addon</button>
        <button type="button" class="catalog-list-chip" data-chip-kind="source" data-chip-value="mdblist" aria-pressed="false" data-act="setCatalogListSearchChip" data-act-args="[&quot;source&quot;,&quot;mdblist&quot;]">MDBList</button>
        <button type="button" class="catalog-list-chip" data-chip-kind="source" data-chip-value="trakt" aria-pressed="false" data-act="setCatalogListSearchChip" data-act-args="[&quot;source&quot;,&quot;trakt&quot;]">Trakt</button>
      </div>
      <div class="catalog-list-chip-row" role="group" aria-label="Order">
        <button type="button" class="catalog-list-chip" data-chip-kind="sort" data-chip-value="popular" aria-pressed="false" data-act="setCatalogListSearchChip" data-act-args="[&quot;sort&quot;,&quot;popular&quot;]">Most liked</button>
        <button type="button" class="catalog-list-chip" data-chip-kind="sort" data-chip-value="new" aria-pressed="false" data-act="setCatalogListSearchChip" data-act-args="[&quot;sort&quot;,&quot;new&quot;]">Newest</button>
        <button type="button" class="catalog-list-chip" data-chip-kind="sort" data-chip-value="added" aria-pressed="false" data-act="setCatalogListSearchChip" data-act-args="[&quot;sort&quot;,&quot;added&quot;]">Most added</button>
      </div>
    </div>


    <div id="catalogSearchResult" class="u-mt-14px"></div>
  </div>
</div>
