<div class="tab-panel" data-tab-panel="lists" id="content-lists" role="tabpanel" aria-labelledby="tab-desktop-lists" hidden>
  <!-- Top Submenu Pills for Lists -->
  <div class="subnav-pills-bar" id="listsSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="my-lists" data-act="switchListsSubmenu" data-act-args="[&quot;my-lists&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> My Lists</button>
    <button type="button" class="subnav-pill" data-sub="liked" data-act="switchListsSubmenu" data-act-args="[&quot;liked&quot;,&quot;@self&quot;]">Liked</button>
    <button type="button" class="subnav-pill" data-sub="import" data-act="switchListsSubmenu" data-act-args="[&quot;import&quot;,&quot;@self&quot;]" style="display:none;">Import</button>
  </div>

  <!-- Submenu 1: User's Connected Account & Custom Lists -->
  <div class="lists-subpanel" id="listsSubMyLists">
    <div class="panel">
      <div class="shelf-header u-mb-12px u-ai-center u-jc-space_between u-gap-12px">
        <div>
          <h2 class="shelf-title sr-only">Your Custom Lists</h2>
          <p class="u-m-0 u-c-v_muted u-fs-v_font_size_sm">Custom lists you've created locally or on your profile.</p>
        </div>
        <div class="u-gap-8px u-ai-center u-fw2-wrap u-fsh-0" style="display:flex;">
          <button type="button" class="primary lc-btn" data-act="openCreateListModal" data-act-args="[&quot;custom&quot;]">+ Create List</button>
          <button type="button" class="secondary lc-btn" data-act="openImportListModal">Import</button>
          ${refreshButtonHtml('appActRefreshCreatorDashboard', 'Refresh lists')}
        </div>
      </div>
      <div id="creatorDashboard"></div>
    </div>

    <div class="panel u-mt-12px" id="myListsSectionPanel-mdblist">
      <div class="shelf-header u-mb-10px">
        <h2 class="panel-title u-mb-0">Your MDBList Lists</h2>
        <div class="u-gap-8px" style="display:flex;">
          <button type="button" class="secondary lc-btn" id="listsMdblistConnectBtn" data-act="toggleListsMdblistConnection">Connect MDBList</button>
        </div>
      </div>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Lists, Watchlist, and Watch History from your connected MDBList account.</p>
      <div id="myMdblistListsResult"></div>
    </div>

    <div class="panel u-mt-12px" id="myListsSectionPanel-trakt">
      <div class="shelf-header u-mb-10px">
        <h2 class="panel-title u-mb-0">Your Trakt Lists</h2>
        <div class="u-gap-8px" style="display:flex;">
          <button type="button" class="secondary lc-btn" id="listsTraktConnectBtn" data-act="toggleListsTraktConnection">Connect Trakt</button>
        </div>
      </div>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Lists, Watchlist, and Watch History from your connected Trakt account.</p>
      <div id="myTraktListsResult"></div>
      <div id="myPrivateTraktListsResult" class="u-mt-10px"></div>
    </div>

    <div class="panel u-mt-12px" id="myListsSectionPanel-tmdb">
      <div class="shelf-header u-mb-10px">
        <h2 class="panel-title u-mb-0">Your TMDB Lists</h2>
        <div class="u-gap-8px" style="display:flex;">
          <button type="button" class="secondary lc-btn" id="listsTmdbConnectBtn" data-act="toggleListsTmdbConnection">Connect TMDB</button>
        </div>
      </div>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Lists, Watchlist, and Favorites from your connected TMDB account.</p>
      <div id="myTmdbListsResult"></div>
    </div>

    <div class="panel u-mt-12px" id="myListsSectionPanel-simkl">
      <div class="shelf-header u-mb-10px">
        <h2 class="panel-title u-mb-0">Your Simkl Lists</h2>
        <div class="u-gap-8px" style="display:flex;">
          <button type="button" class="secondary lc-btn" id="listsSimklConnectBtn" data-act="toggleListsSimklConnection">Connect Simkl</button>
        </div>
      </div>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Lists, Watchlist, and Watch History from your connected Simkl account.</p>
      <div id="mySimklListsResult"></div>
    </div>
  </div>

  <!-- Submenu 2: Liked Lists Feed -->
  <div class="lists-subpanel" id="listsSubLiked" style="display:none;">
    <div class="panel">
      <div class="shelf-header">
        <h2 class="shelf-title sr-only">Lists You Liked</h2>
        <p>Lists you've saved with the heart, from the community directory and from your connected accounts.</p>
        ${refreshButtonHtml('renderLikedListsFeed', 'Refresh liked lists', [true])}
      </div>
      <!-- The placeholder here is the pre-JS state only. renderLikedListsFeed
           overwrites it on every switch to this tab and is authoritative for
           the empty case -- nothing may read this element's children to decide
           whether the feed has loaded. See switchListsSubmenu. -->
      <div id="likedListsFeed"><p class="u-c-v_muted u-fs-v_font_size_sm">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p></div>
    </div>
  </div>

  <!-- Submenu 5: Create Custom List Builder -->
  <div class="lists-subpanel" id="listsSubCreateList" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-10px">
        <h2 class="shelf-title" id="customListEditorTitle">Create a Custom List</h2>
      </div>
      <p class="u-m-0_0_16px u-c-v_muted u-fs-v_font_size_sm">Curate, reorder, and manage titles for this custom list.</p>

      <!-- 1. List Name & Content Type Header Group -->
      <div class="u-gap-20px u-ai-flex_end u-fw2-wrap u-mb-16px" style="display:flex;">
        <div class="u-flex-1_1_320px u-maxw-480px u-minw-0">
          <label for="customListNameInput" class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-6px" style="display:block;">List Name</label>
          <input type="text" id="customListNameInput" placeholder="List name (e.g. My Favorites)" class="u-p-9px_14px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_base u-bs-border_box" style="width:100%;">
        </div>
        <div class="u-flex-0_0_auto">
          <label class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-6px" style="display:block;">Content Type</label>
          <div id="customListTypeToggles" class="u-gap-8px u-ai-center" style="display:flex;">
            <label class="custom-list-type-pill active">
              <input type="radio" name="customListTypeRadio" value="movie" data-act="setCustomListDraftTypeToggle" data-act-args="[&quot;movie&quot;]" checked>
              <span class="check-icon">&#x2713;</span><span>Movies</span>
            </label>
            <label class="custom-list-type-pill">
              <input type="radio" name="customListTypeRadio" value="series" data-act="setCustomListDraftTypeToggle" data-act-args="[&quot;series&quot;]">
              <span class="check-icon">&#x2713;</span><span>Shows</span>
            </label>
            <label class="custom-list-type-pill">
              <input type="radio" name="customListTypeRadio" value="mixed" data-act="setCustomListDraftTypeToggle" data-act-args="[&quot;mixed&quot;]">
              <span class="check-icon">&#x2713;</span><span>Mixed</span>
            </label>
          </div>
        </div>
      </div>

      <!-- 2. Public List Toggle -->
      <div id="customListVisibilityRow" class="u-p-10px_14px u-bg-v_surface u-bd-1px_solid_v_border u-br-v_radius_md u-jc-space_between u-ai-center u-gap-12px u-mb-16px" style="display:flex;">
        <div>
          <span class="u-fs-v_font_size_sm u-fw-600 u-c-v_text">Public List</span>
          <p class="u-m-2px_0_0 u-fs-v_font_size_xs u-c-v_muted">Make this list visible on your public creator profile and discoverable in the community directory</p>
        </div>
        <label class="ui-toggle" aria-label="Make list public">
          <input type="checkbox" id="customListPublicToggle" checked>
          <span class="ui-toggle-slider"></span>
        </label>
      </div>

      <!-- 3. Inline Search & Quick Add Bar -->
      <div class="custom-list-search-section u-bd-1px_solid_v_border u-br-v_radius_md u-p-16px u-bg-v_surface u-mb-16px u-bsh-v_shadow_sm">
        <label for="customListSearchInput" class="u-fs-v_font_size_sm u-fw-700 u-c-v_text u-mb-4px" style="display:block;">Add Titles to List</label>
        <p class="u-m-0_0_10px u-fs-v_font_size_sm u-c-v_muted">Search for movies or shows and tap "+ Add" to add them straight to this list.</p>
        <div class="search-input-box">
          <svg class="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="customListSearchInput" placeholder="Search a title to add...">
          <button type="button" id="customListSearchClearBtn" class="search-clear-btn u-bg-none u-bd-none u-c-v_muted u-cur-pointer u-p-4px" aria-label="Clear search" style="display:none; position:absolute; right:10px; top:50%; transform:translateY(-50%);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm4.3 14.3a.996.996 0 0 1-1.41 0L12 13.41 9.11 16.3a.996.996 0 1 1-1.41-1.41L10.59 12 7.7 9.11A.996.996 0 1 1 9.11 7.7L12 10.59l2.89-2.89a.996.996 0 1 1 1.41 1.41L13.41 12l2.89 2.89c.38.38.38 1.02 0 1.41z"/></svg>
          </button>
        </div>
        <div id="customListSearchResult" class="u-mt-10px"></div>
      </div>

      <!-- 4. Picks in This List -->
      <div class="u-jc-space_between u-ai-center u-fw2-wrap u-gap-8px u-mt-8px u-mb-8px" style="display:flex;">
        <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">
          Picks in this list <span id="customListDraftCount" class="u-fw-normal u-fs-v_font_size_sm u-c-v_muted">(0 items)</span>
        </div>
        <div class="actions u-m-0 u-gap-8px" id="customListDraftActions" style="display:none;">
          <button type="button" class="secondary lc-btn u-fs-v_font_size_sm" data-act="shuffleCustomListDraft">Shuffle Picks Now</button>
          <button type="button" class="secondary lc-btn u-c-v_danger u-bdc-rgba_255_59_48_0_25 u-fs-v_font_size_sm" data-act="removeAllCustomListDraftPicks">Remove All</button>
        </div>
      </div>
      <div id="customListDraftList">
        <p class="u-c-v_muted u-fs-v_font_size_sm"><small>No items in this list yet &mdash; search above or tap + on any movie or show across Discover, Search, or Charts to add it.</small></p>
      </div>

      <!-- 5. Advanced Settings (Progressive Disclosure) -->
      <details class="channel-advanced-details u-mt-16px u-bd-1px_solid_v_border u-br-v_radius_md u-p-12px_16px u-bg-v_surface u-bsh-v_shadow_sm">
        <summary class="u-fw-600 u-fs-v_font_size_sm u-cur-pointer u-us-none u-c-v_text u-ai-center u-jc-space_between" style="display:flex;">
          <span>Advanced Settings</span>
          <span class="u-fs-v_font_size_xs u-c-v_muted u-fw-normal">Play order &amp; watch history rules</span>
        </summary>
        <div class="u-mt-14px u-bdt-1px_solid_v_border u-pt-12px">
          <div class="u-ai-center u-gap-10px u-mb-6px u-fw2-wrap" style="display:flex;">
            <label for="customListPlayOrderSelect" class="u-fs-v_font_size_sm u-fw-600 u-ws-nowrap u-c-v_text">Play order:</label>
            <select id="customListPlayOrderSelect" data-act="applyCustomListPlayOrder" data-act-args="[&quot;@value&quot;]" class="u-maxw-320px u-fs-v_font_size_sm u-p-7px_12px u-bg-v_surface u-c-v_text u-bd-1_5px_solid_v_border_strong u-br-v_radius_pill">
              <option value="as-listed">Creation order (as listed)</option>
              <option value="aired-asc">Air date &mdash; oldest first</option>
              <option value="aired-desc">Air date &mdash; newest first</option>
              <option value="title-az">Title A&ndash;Z</option>
              <option value="shuffle-daily">Shuffle daily (reshuffles every 24h)</option>
            </select>
          </div>
          <p id="customListPlayOrderHint" class="u-m-0_0_14px u-fs-v_font_size_xs" style="color:var(--muted);">Picks play in the order you created above &mdash; drag one, or type a new position, to change it.</p>

          <div class="u-jc-space_between u-ai-center u-gap-12px u-mt-12px u-pt-10px u-bdt-1px_solid_v_border_subtle_rgba_255_255_255_0_08" style="display:flex;">
            <div>
              <span class="u-fs-v_font_size_sm u-fw-600 u-c-v_text">Hide watched</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Skip items already in your watch history (requires Auto-track playback signed in)</p>
            </div>
            <label class="ui-toggle" aria-label="Hide watched items">
              <input type="checkbox" id="customListHideWatchedCheck">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 6. Bottom Action Bar -->
      <div class="actions u-mt-18px u-bdt-1px_solid_v_border u-pt-14px u-jc-flex_end u-gap-10px">
        <button type="button" id="customListCancelEditBtn" class="secondary lc-btn" style="display:none;" data-act="cancelEditCustomList">Cancel</button>
        <button type="button" class="primary lc-btn u-p-8px_24px u-fw-600" id="customListSaveBtn" data-act="saveCustomList">Create List</button>
      </div>
    </div>
  </div>

  <!-- Submenu 7: Import list from a Link -->
  <div class="lists-subpanel" id="listsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header u-mb-10px">
        <h2 class="shelf-title">Import list from a link</h2>
      </div>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Paste any MDBList, Trakt, or TMDB list URL to import directly as a Custom List.</p>
      <div class="row">
        <input type="text" id="customListImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL">
      </div>
      <div class="row u-mt-8px">
        <input type="text" id="customListImportNameInput" placeholder="Name (e.g. My Favorites)">
        <button type="button" class="secondary" id="customListImportBtn" data-act="importCustomListFromLink" data-act-args="[&quot;@self&quot;]">Import list</button>
      </div>
      <label class="u-ai-center u-gap-8px u-cur-pointer u-mt-10px" style="display:flex;">
        <input type="checkbox" id="customListImportSyncCheck" checked>
        <span class="u-fs-v_font_size_sm">Keep custom list synced with external link</span>
      </label>
    </div>

    <!-- The shell's own importer (P6-6): choose a Letterboxd, IMDb or Trakt
         file and the server does the matching, with real progress, a review
         step, and the result saved as a list. Below the link importer. -->
    <div id="appShellImports"></div>
  </div>



</div>
