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
      <div class="shelf-header" style="margin-bottom:12px; align-items:center; justify-content:space-between; gap:12px;">
        <div>
          <h2 class="shelf-title sr-only">Your Custom Lists</h2>
          <p style="margin:0; color:var(--muted); font-size:0.85rem;">Custom lists you've created locally or on your profile.</p>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; flex-shrink:0;">
          <button type="button" class="primary lc-btn" data-act="openCreateListModal" data-act-args="[&quot;custom&quot;]">+ Create List</button>
          <button type="button" class="secondary lc-btn" data-act="openImportListModal">Import</button>
          ${refreshButtonHtml('appActRefreshCreatorDashboard', 'Refresh lists')}
        </div>
      </div>
      <div id="creatorDashboard"></div>
    </div>

    <div class="panel" style="margin-top:12px;" id="myListsSectionPanel-mdblist">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your MDBList Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="secondary lc-btn" id="listsMdblistConnectBtn" data-act="toggleListsMdblistConnection">Connect MDBList</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Watch History from your connected MDBList account.</p>
      <div id="myMdblistListsResult"></div>
    </div>

    <div class="panel" style="margin-top:12px;" id="myListsSectionPanel-trakt">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your Trakt Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="secondary lc-btn" id="listsTraktConnectBtn" data-act="toggleListsTraktConnection">Connect Trakt</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Watch History from your connected Trakt account.</p>
      <div id="myTraktListsResult"></div>
      <div id="myPrivateTraktListsResult" style="margin-top:10px;"></div>
    </div>

    <div class="panel" style="margin-top:12px;" id="myListsSectionPanel-tmdb">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your TMDB Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="secondary lc-btn" id="listsTmdbConnectBtn" data-act="toggleListsTmdbConnection">Connect TMDB</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Favorites from your connected TMDB account.</p>
      <div id="myTmdbListsResult"></div>
    </div>

    <div class="panel" style="margin-top:12px;" id="myListsSectionPanel-simkl">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your Simkl Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="secondary lc-btn" id="listsSimklConnectBtn" data-act="toggleListsSimklConnection">Connect Simkl</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Watch History from your connected Simkl account.</p>
      <div id="mySimklListsResult"></div>
    </div>
  </div>

  <!-- Submenu 2: Liked Lists Feed -->
  <div class="lists-subpanel" id="listsSubLiked" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Lists You Liked</h2>
        ${refreshButtonHtml('renderLikedListsFeed', 'Refresh liked lists', [true])}
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists you've saved with the heart, from the community directory and from your connected accounts.</p>
      <!-- The placeholder here is the pre-JS state only. renderLikedListsFeed
           overwrites it on every switch to this tab and is authoritative for
           the empty case -- nothing may read this element's children to decide
           whether the feed has loaded. See switchListsSubmenu. -->
      <div id="likedListsFeed"><p style="color:var(--muted); font-size:0.88rem;">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p></div>
    </div>
  </div>

  <!-- Submenu 5: Create Custom List Builder -->
  <div class="lists-subpanel" id="listsSubCreateList" style="display:none;">
    <!-- Inline "Add titles" search (P6-4), shell only: type, tap Add, and the
         title is in the draft this panel already saves. -->
    <div id="appShellAddTitles"></div>

    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="customListEditorTitle">Create a Custom List</h2>
      </div>
      <p style="margin:0 0 16px; color:var(--muted); font-size:0.85rem;">Curate, reorder, and manage titles for this custom list.</p>

      <!-- 1. List Name & Content Type Header Group -->
      <div style="display:flex; gap:20px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px;">
        <div style="flex:1 1 320px; max-width:480px; min-width:0;">
          <label for="customListNameInput" style="display:block; font-size:0.85rem; font-weight:600; color:var(--text); margin-bottom:6px;">List Name</label>
          <input type="text" id="customListNameInput" placeholder="List name (e.g. My Favorites)" style="width:100%; padding:9px 14px; border-radius:8px; border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:0.92rem; box-sizing:border-box;">
        </div>
        <div style="flex:0 0 auto;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:var(--text); margin-bottom:6px;">Content Type</label>
          <div id="customListTypeToggles" style="display:flex; gap:8px; align-items:center;">
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
      <div id="customListVisibilityRow" style="padding:10px 14px; background:var(--surface); border:1px solid var(--border); border-radius:10px; display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:16px;">
        <div>
          <span style="font-size:0.88rem; font-weight:600; color:var(--text);">Public List</span>
          <p style="margin:2px 0 0; font-size:0.78rem; color:var(--muted);">Make this list visible on your public creator profile and discoverable in the community directory</p>
        </div>
        <label class="ui-toggle" aria-label="Make list public">
          <input type="checkbox" id="customListPublicToggle" checked>
          <span class="ui-toggle-slider"></span>
        </label>
      </div>

      <!-- 3. Inline Search & Quick Add Bar -->
      <div class="custom-list-search-section" style="border:1px solid var(--border); border-radius:12px; padding:16px; background:var(--surface); margin-bottom:16px; box-shadow:var(--shadow-sm);">
        <label for="customListSearchInput" style="display:block; font-size:0.88rem; font-weight:700; color:var(--text); margin-bottom:4px;">Add Titles to List</label>
        <p style="margin:0 0 10px; font-size:0.8rem; color:var(--muted);">Search for movies or shows and tap "+ Add" to add them straight to this list.</p>
        <div style="position:relative; width:100%;">
          <input type="text" id="customListSearchInput" placeholder="Search a title to add..." style="width:100%; padding:10px 14px 10px 38px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:0.9rem; box-sizing:border-box;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--muted); pointer-events:none;" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <button type="button" id="customListSearchClearBtn" class="search-clear-btn" aria-label="Clear search" style="display:none; position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--muted); cursor:pointer; padding:4px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm4.3 14.3a.996.996 0 0 1-1.41 0L12 13.41 9.11 16.3a.996.996 0 1 1-1.41-1.41L10.59 12 7.7 9.11A.996.996 0 1 1 9.11 7.7L12 10.59l2.89-2.89a.996.996 0 1 1 1.41 1.41L13.41 12l2.89 2.89c.38.38.38 1.02 0 1.41z"/></svg>
          </button>
        </div>
        <div id="customListSearchResult" style="margin-top:10px;"></div>
      </div>

      <!-- 4. Picks in This List -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:8px; margin-bottom:8px;">
        <div style="font-weight:700; font-size:0.92rem; color:var(--text);">
          Picks in this list <span id="customListDraftCount" style="font-weight:normal; font-size:0.8rem; color:var(--muted);">(0 items)</span>
        </div>
        <div class="actions" id="customListDraftActions" style="margin:0; gap:8px; display:none;">
          <button type="button" class="secondary lc-btn" data-act="shuffleCustomListDraft" style="font-size:0.8rem;">Shuffle Picks Now</button>
          <button type="button" class="secondary lc-btn" style="color:var(--danger); border-color:rgba(255,59,48,0.25); font-size:0.8rem;" data-act="removeAllCustomListDraftPicks">Remove All</button>
        </div>
      </div>
      <div id="customListDraftList">
        <p style="color:var(--muted); font-size:0.85rem;"><small>No items in this list yet &mdash; search above or tap + on any movie or show across Discover, Search, or Charts to add it.</small></p>
      </div>

      <!-- 5. Advanced Settings (Progressive Disclosure) -->
      <details class="channel-advanced-details" style="margin-top:16px; border:1px solid var(--border); border-radius:10px; padding:12px 16px; background:var(--surface); box-shadow:var(--shadow-sm);">
        <summary style="font-weight:600; font-size:0.88rem; cursor:pointer; user-select:none; color:var(--text); display:flex; align-items:center; justify-content:space-between;">
          <span>Advanced Settings</span>
          <span style="font-size:0.75rem; color:var(--muted); font-weight:normal;">Play order &amp; watch history rules</span>
        </summary>
        <div style="margin-top:14px; border-top:1px solid var(--border); padding-top:12px;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
            <label for="customListPlayOrderSelect" style="font-size:0.85rem; font-weight:600; white-space:nowrap; color:var(--text);">Play order:</label>
            <select id="customListPlayOrderSelect" data-act="applyCustomListPlayOrder" data-act-args="[&quot;@value&quot;]" style="max-width:320px; font-size:0.86rem; padding:7px 12px; background:var(--surface); color:var(--text); border:1.5px solid var(--border-strong); border-radius:var(--radius-pill);">
              <option value="as-listed">Creation order (as listed)</option>
              <option value="aired-asc">Air date &mdash; oldest first</option>
              <option value="aired-desc">Air date &mdash; newest first</option>
              <option value="title-az">Title A&ndash;Z</option>
              <option value="shuffle-daily">Shuffle daily (reshuffles every 24h)</option>
            </select>
          </div>
          <p id="customListPlayOrderHint" style="margin:0 0 14px; color:var(--muted); font-size:0.78rem;">Picks play in the order you created above &mdash; drag one, or type a new position, to change it.</p>

          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:12px; padding-top:10px; border-top:1px solid var(--border-subtle, rgba(255,255,255,0.08));">
            <div>
              <span style="font-size:0.86rem; font-weight:600; color:var(--text);">Hide watched</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:0.78rem;">Skip items already in your watch history (requires Auto-track playback signed in)</p>
            </div>
            <label class="ui-toggle" aria-label="Hide watched items">
              <input type="checkbox" id="customListHideWatchedCheck">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 6. Bottom Action Bar -->
      <div class="actions" style="margin-top:18px; border-top:1px solid var(--border); padding-top:14px; justify-content:flex-end; gap:10px;">
        <button type="button" id="customListCancelEditBtn" class="secondary lc-btn" style="display:none;" data-act="cancelEditCustomList">Cancel</button>
        <button type="button" class="primary lc-btn" id="customListSaveBtn" data-act="saveCustomList" style="padding:8px 24px; font-weight:600;">Create List</button>
      </div>
    </div>
  </div>

  <!-- Submenu 7: Import list from a Link -->
  <div class="lists-subpanel" id="listsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Import list from a link</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste any MDBList, Trakt, or TMDB list URL to import directly as a Custom List.</p>
      <div class="row">
        <input type="text" id="customListImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="customListImportNameInput" placeholder="Name (e.g. My Favorites)">
        <button type="button" class="secondary" id="customListImportBtn" data-act="importCustomListFromLink" data-act-args="[&quot;@self&quot;]">Import list</button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:10px;">
        <input type="checkbox" id="customListImportSyncCheck" checked>
        <span style="font-size:0.85rem;">Keep custom list synced with external link</span>
      </label>
    </div>

    <!-- The shell's own importer (P6-6): choose a Letterboxd, IMDb or Trakt
         file and the server does the matching, with real progress, a review
         step, and the result saved as a list. Below the link importer. -->
    <div id="appShellImports"></div>
  </div>



</div>
