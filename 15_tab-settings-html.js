  <!-- Subpanel 1: Account & Security -->
  <div class="settings-subpanel" id="settingsSubAccount">
    <div class="panel">
      <h2 class="panel-title">Your Account</h2>
      <div id="accountKeySection"></div>
    </div>
  </div>

  <!-- Subpanel 2: Catalog & Display -->
  <div class="settings-subpanel" id="settingsSubDisplay" style="display:none;">
    <!-- Consolidated Catalog & Content Rules (P1 & P2) -->
    <div class="panel">
      <div class="shelf-header u-mb-8px">
        <h2 class="shelf-title">Catalog &amp; Content Rules</h2>
      </div>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Configure streaming availability, digital release filters, cross-list deduplication, and adult content safety.</p>

      <div class="settings-row-group">
        <!-- Region -->
        <div class="settings-row-item u-pb-14px u-bdb-1px_solid_v_border">
          <div class="u-jc-space_between u-ai-flex_start u-gap-16px u-fw2-wrap" style="display:flex;">
            <div class="u-flex-1 u-minw-240px">
              <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Content Region</span>
              <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Used for streaming-availability catalogs (Netflix, Disney+, etc.), Stream Releases, and content ratings.</p>
            </div>
            <div class="u-flex-none u-maxw-320px" style="width:100%;">
              <select id="regionSelect" aria-label="Streaming region" data-act="appActStoreSettingValue" data-act-args="[&quot;myListAddon:region&quot;,&quot;@value&quot;]" class="u-maxw-320px u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box" style="width:100%;">
                ${buildRegionOptionsHtml(initialRegion)}
              </select>
            </div>
          </div>
        </div>

        <!-- Digital Release Filter -->
        <div class="settings-row-item u-p-14px_0 u-bdb-1px_solid_v_border">
          <div class="settings-toggle-row u-p-0 u-bd-none">
            <div class="u-flex-1 u-minw-0 u-pr-12px">
              <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Hide items with no digital release</span>
              <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Removes still-in-theaters movies with no known digital or physical release from TMDB Trending and Popular catalogs.</p>
              <details class="u-mt-6px u-fs-v_font_size_sm u-c-v_muted">
                <summary class="u-cur-pointer u-c-v_accent u-fw-600">More details</summary>
                <p class="u-m-4px_0_0">Useful for skipping in-theaters titles you cannot stream or buy yet. TV Shows are not affected. Requires Save/Update to take effect on an existing install link.</p>
              </details>
            </div>
            <label class="ui-toggle" aria-label="Hide items with no digital release">
              <input type="checkbox" id="hideNonDigitalReleasesCheckbox" ${initialHideNonDigitalReleases ? 'checked' : ''} data-act="appActStoreSettingChecked" data-act-args="[&quot;myListAddon:hideNonDigitalReleases&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- Deduplication -->
        <div class="settings-row-item u-p-14px_0 u-bdb-1px_solid_v_border" id="legacyDedupePanel">
          <div class="settings-toggle-row u-p-0 u-bd-none">
            <div class="u-flex-1 u-minw-0 u-pr-12px">
              <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Remove duplicate items across lists</span>
              <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Automatically removes titles from lower catalog rows if already shown in a row above.</p>
              <details class="u-mt-6px u-fs-v_font_size_sm u-c-v_muted">
                <summary class="u-cur-pointer u-c-v_accent u-fw-600">How row deduplication works</summary>
                <p class="u-m-4px_0_0">Keeps your top catalog row intact; every list below it has items shown in earlier lists filtered out. Drag lists in Catalogs to change priority. Requires Save/Update to take effect on an existing install link.</p>
              </details>
            </div>
            <label class="ui-toggle" aria-label="Remove duplicate items across lists">
              <input type="checkbox" id="dedupeAcrossListsCheckbox" ${initialDedupeAcrossLists ? 'checked' : ''} data-act="appActStoreSettingChecked" data-act-args="[&quot;myListAddon:dedupeAcrossLists&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- Adult Content -->
        <div class="settings-row-item u-pt-14px">
          <div class="settings-toggle-row u-p-0 u-bd-none">
            <div class="u-flex-1 u-minw-0 u-pr-12px">
              <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Adult Content Filter</span>
              <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Filter NSFW posters and replace default unfiltered posters with safe, age-appropriate ones across your catalogs, search, continue watching, and Stremio/Nuvio.</p>
            </div>
            <label class="ui-toggle" aria-label="Adult Content Filter">
              <input type="checkbox" id="adultContentFilterCheckbox" ${initialAdultContentFilter ? 'checked' : ''} data-act="appActToggleAdultFilter" data-act-args="[&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Better Posters Panel (P2 & P3) -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">Better Posters</h2>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Swap plain poster artwork for <a href="https://btttr.cc/" target="_blank" rel="noopener noreferrer" class="u-c-v_accent">BetterPosters</a> &mdash; posters with the genre, rating and tags drawn directly into the artwork. No API key or account needed.</p>
      <div class="settings-toggle-row u-p-0_0_12px u-bdb-none">
        <div class="u-flex-1 u-minw-0 u-pr-12px">
          <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Use Better Posters artwork</span>
          <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Enriches artwork across Live Preview, Search, Discover, and your streaming catalog rows.</p>
          <details class="u-mt-6px u-fs-v_font_size_sm u-c-v_muted">
            <summary class="u-cur-pointer u-c-v_accent u-fw-600">Artwork compatibility details</summary>
            <p class="u-m-4px_0_0">Only titles with an IMDb ID are affected. Poster badges are drawn over this artwork rather than replacing it. Adult Content Filter still overrides it. TV Channel artwork and episode stills are preserved.</p>
          </details>
        </div>
        <label class="ui-toggle" aria-label="Use Better Posters artwork">
          <input type="checkbox" id="betterPostersCheckbox" ${initialBetterPosters ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPosters&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <div id="betterPostersOptions" style="display:${initialBetterPosters ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_text">What to draw on the poster</div>
        <div class="settings-check-group two-col-grid">
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersGenreCheckbox" ${initialBetterPostersGenre ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersGenre&quot;,&quot;@checked&quot;]">
            <div class="u-flex-1 u-minw-0">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Genre</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Genre label along the bottom of the poster.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersRatingCheckbox" ${initialBetterPostersRating ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersRating&quot;,&quot;@checked&quot;]">
            <div class="u-flex-1 u-minw-0">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Rating</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Star rating along the bottom of the poster.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersTrendTagsCheckbox" ${initialBetterPostersTrendTags ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersTrendTags&quot;,&quot;@checked&quot;]">
            <div class="u-flex-1 u-minw-0">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Trend tags</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">A corner tag on titles that are currently trending or newly released.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersQualityCheckbox" ${initialBetterPostersQuality ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersQuality&quot;,&quot;@checked&quot;]">
            <div class="u-flex-1 u-minw-0">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Quality tags</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">4K, Dolby Vision and Atmos badges, where BetterPosters knows them.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersAgeCheckbox" ${initialBetterPostersAge ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersAge&quot;,&quot;@checked&quot;]">
            <div class="u-flex-1 u-minw-0">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Age rating</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Certification chip (PG-13, TV-MA, and so on).</p>
            </div>
          </label>
        </div>
        <div class="u-gap-16px u-fw2-wrap u-mt-6px" style="display:flex;">
          <div class="u-flex-1 u-minw-220px u-maxw-320px">
            <label for="betterPostersRatingSourceSelect" class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">Rating source</label>
            <select id="betterPostersRatingSourceSelect" data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersRatingSource&quot;,&quot;@value&quot;]" class="u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box" style="width:100%;">
              ${betterPostersRatingSourceOptionsHtml}
            </select>
            <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_xs">Which score the rating is taken from.</p>
          </div>
          <div class="u-flex-1 u-minw-220px u-maxw-320px">
            <label for="betterPostersLangSelect" class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">Poster language</label>
            <select id="betterPostersLangSelect" data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersLang&quot;,&quot;@value&quot;]" class="u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box" style="width:100%;">
              ${betterPostersLangOptionsHtml}
            </select>
            <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_xs">Language BetterPosters draws text in.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- RatingPosterDB Panel -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">RatingPosterDB</h2>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Swap plain poster artwork for <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer" class="u-c-v_accent">RatingPosterDB</a> posters with ratings drawn on, styled the way you set them up at <a href="https://manager.ratingposterdb.com/" target="_blank" rel="noopener noreferrer" class="u-c-v_accent">manager.ratingposterdb.com</a>. Needs your own paid RPDB API key.</p>
      <div class="settings-toggle-row u-p-0_0_12px u-bdb-none">
        <div class="u-flex-1 u-minw-0 u-pr-12px">
          <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Use RatingPosterDB artwork</span>
          <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Replaces poster artwork in Stremio and Nuvio. Turns Better Posters and Pictorium off, because only one can draw a poster.</p>
          <details class="u-mt-6px u-fs-v_font_size_sm u-c-v_muted">
            <summary class="u-cur-pointer u-c-v_accent u-fw-600">How your request limit is protected</summary>
            <p class="u-m-4px_0_0">Every poster RatingPosterDB sends counts against your key's monthly limit, so posters are not loaded from it directly. This add-on fetches each poster once, keeps it for three days, and shows it to every device from that copy. It asks RatingPosterDB for at most 20 new posters a minute, so a page of new titles fills in over a few minutes (the ordinary poster shows meanwhile), and it stops asking once 95% of your monthly limit is used. Only titles with an IMDb ID are affected. Airing Next and date badges are not drawn over these posters. The website keeps its normal posters.</p>
          </details>
        </div>
        <label class="ui-toggle" aria-label="Use RatingPosterDB artwork">
          <input type="checkbox" id="rpdbCheckbox" ${initialRpdb ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;rpdb&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <div id="rpdbOptions" style="display:${initialRpdb ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div>
          <label for="rpdbKeyInput" class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">API key</label>
          <div class="u-gap-8px u-fw2-wrap u-ai-center" style="display:flex;">
            <input type="password" id="rpdbKeyInput" value="${escapeHtmlServer(initialRpdbKey)}" placeholder="t1-..." autocomplete="off" spellcheck="false" data-act="toggleBetterPostersSetting" data-act-args="[&quot;rpdbKey&quot;,&quot;@value&quot;]" class="u-flex-1 u-minw-200px u-maxw-380px u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box">
            <button type="button" class="secondary lc-btn u-br-v_radius_pill" data-act="testRpdbKey" data-act-args="[&quot;@self&quot;]">Test key</button>
          </div>
          <p id="rpdbKeyStatus" class="u-m-4px_0_0 u-fs-v_font_size_xs" style="color:var(--muted);">Your key starts with t1- to t4- and is in the email RatingPosterDB sent you, or at ratingposterdb.com after you log in with Patreon. Test key shows whether it works and how much of this month's limit is used.</p>
        </div>
      </div>
    </div>

    <!-- Pictorium Panel -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">Pictorium</h2>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Swap plain poster artwork for posters drawn by your own <a href="https://github.com/Eful97/Pictorium" target="_blank" rel="noopener noreferrer" class="u-c-v_accent">Pictorium</a> space &mdash; ratings, streaming quality, Netflix Top 10 ribbons, awards and more, styled the way you set them up there. Needs a Pictorium space with your own TMDB key.</p>
      <div class="settings-toggle-row u-p-0_0_12px u-bdb-none">
        <div class="u-flex-1 u-minw-0 u-pr-12px">
          <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Use Pictorium artwork</span>
          <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Replaces poster artwork in Stremio and Nuvio and across the website. Turns Better Posters and RatingPosterDB off, because only one can draw a poster.</p>
          <details class="u-mt-6px u-fs-v_font_size_sm u-c-v_muted">
            <summary class="u-cur-pointer u-c-v_accent u-fw-600">Artwork compatibility details</summary>
            <p class="u-m-4px_0_0">Only titles with an IMDb ID are affected. Pictorium draws its own badges, so the Airing Next and date badges are not drawn over its posters. Adult Content Filter still overrides it on the website. TV Channel artwork and episode stills are preserved.</p>
          </details>
        </div>
        <label class="ui-toggle" aria-label="Use Pictorium artwork">
          <input type="checkbox" id="pictoriumCheckbox" ${initialPictorium ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;pictorium&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <div id="pictoriumOptions" style="display:${initialPictorium ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div>
          <label for="pictoriumUrlInput" class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">Poster link</label>
          <input type="url" id="pictoriumUrlInput" value="${escapeHtmlServer(initialPictoriumUrl)}" placeholder="https://your-pictorium-host/api/poster/{type}/{tmdb_id|imdb_id}?u=..." autocomplete="off" spellcheck="false" data-act="toggleBetterPostersSetting" data-act-args="[&quot;pictoriumUrl&quot;,&quot;@value&quot;]" class="u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box" style="width:100%;">
          <p id="pictoriumUrlHint" class="u-m-4px_0_0 u-fs-v_font_size_xs" style="color:var(--muted);">In your Pictorium space, copy the <strong>AIOMetadata</strong> poster link and paste it here as it is. It has to start with https:// and contain <code>/api/poster/</code>, <code>{type}</code> and <code>{tmdb_id|imdb_id}</code>.</p>
        </div>
      </div>
    </div>

    <!-- Metadata Panel -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">Metadata</h2>
      <div class="settings-toggle-row u-p-0 u-bdb-none">
        <div class="u-flex-1 u-minw-0 u-pr-12px">
          <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Use My Lists Addon metadata</span>
          <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Lets this add-on supply a title's details page (synopsis, cast, trailers, episodes) in Stremio and Nuvio. Turn it off to use My Lists Addon for lists only and let another add-on supply the details. TV Channel titles keep their details page. Reinstall the add-on after changing this. Posters on the list tiles still come from this add-on (see Better Posters and Pictorium above), not from the other add-on.</p>
        </div>
        <label class="ui-toggle" aria-label="Use My Lists Addon metadata">
          <input type="checkbox" id="provideMetadataCheckbox" ${initialProvideMetadata ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;provideMetadata&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- Poster Badges & Labels Panel (P3) -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">Poster Badges &amp; Labels</h2>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Customize which badges and indicators are displayed on posters across your website dashboard, catalogs, and Stremio/Nuvio.</p>
      <div class="u-fd-column u-gap-16px" style="display:flex;">
        <div class="u-bdb-1px_solid_v_border u-pb-14px u-fd-column u-gap-6px" style="display:flex;">
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_text u-mb-4px">Website &amp; Dashboard</div>
          <div class="settings-check-group two-col-grid">
            <label class="settings-check-item">
              <input type="checkbox" id="badgeAiringNextCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesAiringNext&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Airing Next (Dashboard)</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Airing Next shelf and provider lists on your dashboard</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeContinueWatchingCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesContinueWatching&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Continue Watching</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">In-progress series on your website dashboard</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeWatchlistCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesWatchlist&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Watchlist</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Shows in your Watchlist with upcoming episodes</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeTraktContinueWatchingCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesTraktContinueWatching&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Trakt Continue Watching</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Connected Trakt Continue Watching series</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeMdblistUpNextCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesMdblistUpNext&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">MDBList Up Next</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Connected MDBList Up Next series</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeCatalogsCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesCatalogs&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Catalogs &amp; Live Preview</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Catalog rows, Catalogs Live Preview &amp; Editor, and See All views</p>
              </div>
            </label>
          </div>
        </div>

        <div class="u-bdb-1px_solid_v_border u-pb-14px u-fd-column u-gap-6px" style="display:flex;">
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_text u-mb-4px">Stremio &amp; Nuvio (Artwork Overlays)</div>
          <div class="settings-check-group two-col-grid">
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioAiringNextCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioAiringNext&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Airing Next Catalogs in Stremio &amp; Nuvio</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Overlay premiere, finale, and air date chips in Stremio and Nuvio</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioContinueWatchingCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioContinueWatching&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Continue Watching Catalogs in Stremio &amp; Nuvio</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Overlay chips on Continue Watching artwork in Stremio and Nuvio</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioWatchlistCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioWatchlist&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Watchlist Catalogs in Stremio &amp; Nuvio</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Overlay chips on Watchlist artwork in Stremio and Nuvio</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioCatalogsCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioCatalogs&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Other Custom &amp; Provider Catalogs</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Overlay badges on MDBList, Trakt, Simkl, and Custom list rows</p>
              </div>
            </label>
          </div>
        </div>

        <div class="u-fd-column u-gap-6px" style="display:flex;">
          <div class="u-fs-v_font_size_sm u-fw-700 u-c-v_text u-mb-4px">Badge Types</div>
          <div class="settings-check-group two-col-grid">
            <label class="settings-check-item">
              <input type="checkbox" id="badgeAirDateCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeAirDate&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Upcoming Air Date</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Air date countdown (e.g. <code>TODAY</code>, <code>TOMORROW</code>)</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeSeasonPremiereCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeSeasonPremiere&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Season Premiere</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Green <code>Season Premiere</code> badge on un-aired Episode 1s</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeSeasonFinaleCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeSeasonFinale&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Season Finale</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Orange <code>Season Finale</code> badge on season finales</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeSeasonFinaleDateCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeSeasonFinaleDate&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Season Finale Date</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Date when the season finale will air on mid-season episodes</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeTmdbRatingCheckbox" checked data-act="toggleTmdbRatingSetting" data-act-args="[&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">TMDb Ratings</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Star rating (e.g. <span class="u-c-f5c518 u-fw-700">★ 7.9</span>) beside the year/subtitle</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeWatchedCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeWatched&quot;,&quot;@checked&quot;]">
              <div class="u-flex-1 u-minw-0">
                <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Watched Status Badges</span>
                <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Checkmark badge on movies and shows you've already watched</p>
              </div>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Hidden Lists Panel -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">Hidden Lists</h2>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Hide specific lists from My Lists, Airing Next, and Simkl Airing Next. A hidden list is still tracked and updated normally underneath -- only its display is suppressed, and it can be shown again here at any time.</p>
      <div id="hiddenListsSettingsSection"></div>
    </div>
  </div>

  <!-- Subpanel 3: Tracking & Scrobble -->
  <div class="settings-subpanel" id="settingsSubScrobble" style="display:none;">
    <div class="panel">
      <h2 class="panel-title">Watchlist Preferences</h2>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Customize how watched movies and TV shows are managed in your personal Watchlist.</p>
      <div id="watchlistPreferencesSection"></div>
    </div>

    <div class="panel u-mt-12px">
      <h2 class="panel-title">Watch History &amp; Continue Watching</h2>
      <div class="u-bdb-1px_solid_v_border u-pb-12px u-mb-12px">
        <div class="settings-toggle-row u-pt-4px">
          <div class="u-flex-1 u-minw-0 u-pr-12px">
            <span class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Storyline &amp; Companion Recommendations</span>
            <p class="u-m-3px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Automatically recommend canon bridge movies between seasons (e.g. <em>Demon Slayer: Mugen Train</em>) and sequel films or spin-off series when a show concludes (e.g. <em>Breaking Bad &rarr; El Camino &rarr; Better Call Saul</em>).</p>
          </div>
          <label class="ui-toggle" aria-label="Toggle Storyline and Companion Recommendations">
            <input type="checkbox" id="autoRecommendCompanionsCheckbox" checked data-act="toggleCompanionRecommendationSetting" data-act-args="[&quot;@checked&quot;]">
            <span class="ui-toggle-slider"></span>
          </label>
        </div>
      </div>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Reset or clear all recorded movies and episodes from your personal Watch History or in-progress Continue Watching.</p>
      <div id="watchHistorySettingsSection" class="u-gap-10px u-fw2-wrap" style="display:flex;">
        <button type="button" class="btn-danger btn-sm" data-act="clearWatchHistoryAll">Clear Watch History</button>
        <button type="button" class="btn-danger btn-sm" data-act="clearContinueWatchingAll">Clear Continue Watching</button>
      </div>
    </div>

    <div class="panel u-mt-12px">
      <h2 class="panel-title">Auto-Track &amp; Media Server Scrobbling</h2>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">Automatically scrobble and track watched movies and TV episodes across your streaming apps (Stremio, Nuvio, Wako, etc.) and home media servers (Plex, Jellyfin, Emby) into your personal Watch History and Continue Watching.</p>
      <div id="trackPlaybackSection"></div>
    </div>
  </div>

  <!-- Submenu 2: External Accounts & API Keys -->
  <div class="settings-subpanel" id="settingsSubExternal" style="display:none;">
    <div class="panel">
      <h2 class="panel-title">External Accounts &amp; API Keys</h2>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Connect your external service accounts and API keys. When signed in to your Profile, your connected accounts stay synchronized across devices and logouts.</p>

      <!-- TMDB Section -->
      <div class="provider-card" id="tmdbSection">
        <div class="provider-card-header">
          <div>
            <div class="u-ai-center u-gap-8px u-fw2-wrap" style="display:flex;">
              <span class="provider-card-title">The Movie Database (TMDB)</span>
              <span id="tmdbConnectStatus" class="provider-status-badge"><span class="u-c-v_muted">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your TMDB account to import personal lists, watchlist, and favorites, or use a custom API key / Token.</p>
          </div>
        </div>
        <div class="provider-card-actions">
          <button type="button" class="secondary lc-btn u-fw-600" id="tmdbConnectBtn" data-act="startTmdbConnect">Connect TMDB Account</button>
          <button type="button" class="secondary lc-btn btn-danger" id="tmdbDisconnectBtn" style="display:none;" data-act="disconnectTmdb">Disconnect</button>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom TMDB API Key / Token</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div class="u-mt-10px">
            <input type="text" id="tmdbKeyInput" placeholder="Optional: TMDB API Key (v3) or Read Access Token (v4)" value="${escapeHtmlServer(initialTmdbKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;tmdb&quot;,&quot;@value&quot;]" class="u-p-9px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-bs-border_box" style="width:100%;">
            <p class="u-m-6px_0_0 u-fs-v_font_size_xs u-c-v_muted">Get a free TMDB API key at <a href="https://www.themoviedb.org/settings/api" target="_blank" class="u-c-v_accent_2">themoviedb.org/settings/api</a>.</p>
          </div>
        </details>
      </div>

      <!-- Trakt Section -->
      <div class="provider-card" id="traktSection">
        <div class="provider-card-header">
          <div>
            <div class="u-ai-center u-gap-8px u-fw2-wrap" style="display:flex;">
              <span class="provider-card-title">Trakt</span>
              <span id="traktConnectStatus" class="provider-status-badge"><span class="u-c-v_muted">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your Trakt account to import personal lists, watchlist, and collection, or use a custom Client ID.</p>
          </div>
        </div>
        <div class="provider-card-actions trakt-connect-actions">
          <button type="button" class="secondary lc-btn u-fw-600" id="traktConnectBtn" data-act="startTraktConnect">Connect Trakt Account</button>
          <button type="button" class="secondary lc-btn" id="traktDeviceBtn" data-act="startTraktDeviceLogin" title="Connect from a TV or secondary device via trakt.tv/activate">Connect with PIN / Code</button>
          <button type="button" class="secondary lc-btn btn-danger" id="traktDisconnectBtn" style="display:none;" data-act="disconnectTrakt">Disconnect</button>
        </div>
        <div id="traktSyncHistoryWrap" class="u-m-10px_0 u-p-12px_14px u-bg-v_surface_2_rgba_255_255_255_0_04 u-br-v_radius_sm u-bd-1px_solid_v_border">
          <div class="settings-toggle-row u-p-0_0_10px">
            <div class="u-flex-1 u-minw-0 u-pr-12px">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Sync Watch History to Trakt</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Automatically sync items marked as watched or played to your Trakt account history.</p>
            </div>
            <label class="ui-toggle" aria-label="Sync Watch History to Trakt">
              <input type="checkbox" id="syncTraktHistoryCheckbox" data-act="toggleProviderHistorySync" data-act-args="[&quot;trakt&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
          <div class="u-mt-8px">
            <button type="button" class="secondary lc-btn u-p-4px_10px u-fs-v_font_size_sm" id="syncTraktHistoryNowBtn" data-act="syncWatchHistoryToProviderNow" data-act-args="[&quot;trakt&quot;,&quot;@self&quot;]">Sync Current Watch History Now</button>
          </div>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom Trakt Client ID &amp; Username</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div class="u-mt-10px u-fd-column u-gap-8px" style="display:flex;">
            <input type="text" id="traktKeyInput" placeholder="Optional: Trakt Client ID" value="${escapeHtmlServer(initialTraktKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;trakt&quot;,&quot;@value&quot;]" class="u-p-9px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-bs-border_box" style="width:100%;">
            <input type="text" id="traktUsernameInput" placeholder="Optional: Trakt username" value="${escapeHtmlServer(initialTraktUsername)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;trakt&quot;,&quot;@value&quot;]" class="u-p-9px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-bs-border_box" style="width:100%;">
            <p class="u-m-2px_0_0 u-fs-v_font_size_xs u-c-v_muted">Create a free Trakt Client ID at <a href="https://trakt.tv/oauth/applications" target="_blank" class="u-c-v_accent_2">trakt.tv/oauth/applications</a>.</p>
          </div>
        </details>
      </div>

      <!-- MDBList Section -->
      <div class="provider-card" id="mdblistSection">
        <div class="provider-card-header">
          <div>
            <div class="u-ai-center u-gap-8px u-fw2-wrap" style="display:flex;">
              <span class="provider-card-title">MDBList</span>
              <span id="mdblistConnectStatus" class="provider-status-badge"><span class="u-c-v_muted">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your MDBList account to import personal lists, watchlist, and watch history, or use a custom API key.</p>
          </div>
        </div>
        <div class="provider-card-actions">
          <button type="button" class="secondary lc-btn u-fw-600" id="mdblistConnectBtn" data-act="startMdblistConnect">Connect MDBList Account</button>
          <button type="button" class="secondary lc-btn btn-danger" id="mdblistDisconnectBtn" style="display:none;" data-act="disconnectMdblist">Disconnect</button>
        </div>
        <div id="mdblistSyncHistoryWrap" class="u-m-10px_0 u-p-12px_14px u-bg-v_surface_2_rgba_255_255_255_0_04 u-br-v_radius_sm u-bd-1px_solid_v_border">
          <div class="settings-toggle-row u-p-0_0_10px">
            <div class="u-flex-1 u-minw-0 u-pr-12px">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Sync Watch History to MDBList</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Automatically sync items marked as watched or played to your MDBList account history.</p>
            </div>
            <label class="ui-toggle" aria-label="Sync Watch History to MDBList">
              <input type="checkbox" id="syncMdblistHistoryCheckbox" data-act="toggleProviderHistorySync" data-act-args="[&quot;mdblist&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
          <div class="u-mt-8px">
            <button type="button" class="secondary lc-btn u-p-4px_10px u-fs-v_font_size_sm" id="syncMdblistHistoryNowBtn" data-act="syncWatchHistoryToProviderNow" data-act-args="[&quot;mdblist&quot;,&quot;@self&quot;]">Sync Current Watch History Now</button>
          </div>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom MDBList API Key</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div class="u-mt-10px">
            <input type="text" id="mdblistKeyInput" placeholder="Optional: MDBList API key" value="${escapeHtmlServer(initialMdblistKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;mdblist&quot;,&quot;@value&quot;]" class="u-p-9px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-bs-border_box" style="width:100%;">
            <p class="u-m-6px_0_0 u-fs-v_font_size_xs u-c-v_muted">Get a free MDBList key at <a href="https://mdblist.com/preferences" target="_blank" class="u-c-v_accent_2">mdblist.com/preferences</a>.</p>
          </div>
        </details>
      </div>

      <!-- Simkl Section -->
      <div class="provider-card" id="simklSection">
        <div class="provider-card-header">
          <div>
            <div class="u-ai-center u-gap-8px u-fw2-wrap" style="display:flex;">
              <span class="provider-card-title">Simkl</span>
              <span id="simklConnectStatus" class="provider-status-badge"><span class="u-c-v_muted">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your Simkl account to import personal lists, watchlist, and history, or use a custom Client ID.</p>
          </div>
        </div>
        <div class="provider-card-actions">
          <button type="button" class="secondary lc-btn u-fw-600" id="simklConnectBtn" data-act="startSimklConnect">Connect Simkl Account</button>
          <button type="button" class="secondary lc-btn btn-danger" id="simklDisconnectBtn" style="display:none;" data-act="disconnectSimkl">Disconnect</button>
        </div>
        <div id="simklSyncHistoryWrap" class="u-m-10px_0 u-p-12px_14px u-bg-v_surface_2_rgba_255_255_255_0_04 u-br-v_radius_sm u-bd-1px_solid_v_border">
          <div class="settings-toggle-row u-p-0_0_10px">
            <div class="u-flex-1 u-minw-0 u-pr-12px">
              <span class="u-fw-600 u-fs-v_font_size_sm u-c-v_text">Sync Watch History to Simkl</span>
              <p class="u-m-2px_0_0 u-c-v_muted u-fs-v_font_size_xs">Automatically sync items marked as watched or played to your Simkl account history.</p>
            </div>
            <label class="ui-toggle" aria-label="Sync Watch History to Simkl">
              <input type="checkbox" id="syncSimklHistoryCheckbox" data-act="toggleProviderHistorySync" data-act-args="[&quot;simkl&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
          <div class="u-mt-8px">
            <button type="button" class="secondary lc-btn u-p-4px_10px u-fs-v_font_size_sm" id="syncSimklHistoryNowBtn" data-act="syncWatchHistoryToProviderNow" data-act-args="[&quot;simkl&quot;,&quot;@self&quot;]">Sync Current Watch History Now</button>
          </div>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom Simkl Client ID</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div class="u-mt-10px">
            <input type="text" id="simklKeyInput" placeholder="Optional: Simkl Client ID" value="${escapeHtmlServer(initialSimklKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;simkl&quot;,&quot;@value&quot;]" class="u-p-9px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-bs-border_box" style="width:100%;">
            <p class="u-m-6px_0_0 u-fs-v_font_size_xs u-c-v_muted">Create a free Simkl Client ID at <a href="https://simkl.com/settings/developer/" target="_blank" class="u-c-v_accent_2">simkl.com/settings/developer/</a>.</p>
          </div>
        </details>
      </div>
    </div>

    <!-- Unified Import List Panel -->
    <div class="panel u-mt-14px">
      <h2 class="panel-title">Import List</h2>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Import files to automatically populate or create custom lists in your account. Supports CSV and JSON exports from IMDb, Letterboxd, MovieLens, Trakt, Simkl, and TMDB.</p>

      <div class="u-gtc-repeat_auto_fit_minmax_260px_1fr u-gap-12px u-mb-12px" style="display:grid;">
        <div>
          <label for="importListSourceSelect" class="u-fw-600 u-fs-v_font_size_sm u-mb-6px u-c-v_text" style="display:block;">Source (optional)</label>
          <select id="importListSourceSelect" class="u-maxw-320px u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box" style="width:100%;">
            <option value="auto">Auto-detect</option>
            <option value="imdb">IMDb</option>
            <option value="letterboxd">Letterboxd</option>
            <option value="movielens">MovieLens</option>
            <option value="trakt">Trakt</option>
            <option value="simkl">Simkl</option>
            <option value="tmdb">TMDB</option>
          </select>
        </div>

        <div>
          <label for="importTargetListSelect" class="u-fw-600 u-fs-v_font_size_sm u-mb-6px u-c-v_text" style="display:block;">Import to which list?</label>
          <select id="importTargetListSelect" class="u-maxw-320px u-p-7px_12px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_sm u-bs-border_box" style="width:100%;" data-act="onImportTargetListChange">
            <!-- Populated dynamically -->
          </select>
        </div>
      </div>

      <div id="importNewListInputWrap" class="u-mb-12px" style="display:none;">
        <label for="importNewListNameInput" class="u-fw-600 u-fs-v_font_size_sm u-mb-6px u-c-v_text" style="display:block;">New List Name</label>
        <input type="text" id="importNewListNameInput" placeholder="e.g. My Favorite Movies" class="u-maxw-400px u-p-9px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_base u-bs-border_box" style="width:100%;">
      </div>

      <div class="u-mb-14px">
        <div class="import-dropzone" id="importDropzone" data-act="appActOpenFilePicker" data-act-args="[&quot;unifiedImportFileInput&quot;]">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="u-c-v_muted u-mb-2px" style="opacity:0.8;" aria-hidden="true">
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path>
            <path d="M12 12v9"></path>
            <path d="m16 16-4-4-4 4"></path>
          </svg>
          <div class="u-ta-center">
            <div class="u-fw-600 u-fs-v_font_size_base u-c-v_text">Choose files or drag &amp; drop here</div>
            <div class="u-mt-3px u-c-v_muted u-fs-v_font_size_xs">CSV, JSON, ZIP, or TXT exports (multi-file supported)</div>
          </div>
          <button type="button" class="secondary lc-btn u-p-6px_16px u-fs-v_font_size_sm u-mt-2px" data-act="appActOpenFilePicker" data-act-args="[&quot;unifiedImportFileInput&quot;]">Select files&hellip;</button>
          <input type="file" id="unifiedImportFileInput" aria-label="Choose a file to import" multiple accept=".csv,.json,.zip,.txt" style="display:none;" data-act="onUnifiedImportFilesSelected" data-act-args="[&quot;@self&quot;]">
        </div>
        <div id="unifiedImportSelectedCount" class="u-mt-6px u-fs-v_font_size_sm u-c-v_muted">No files selected</div>
      </div>

      <div class="u-mb-14px">
        <label class="settings-check-item u-p-10px_12px u-m-0">
          <input type="checkbox" id="importAlsoMarkWatchedCheck">
          <div class="settings-check-label">
            <strong class="u-fs-v_font_size_sm u-c-v_text">Also add watched items to Watch History</strong>
            <span class="settings-check-desc">Automatically marks imported watched items in your Watch History</span>
          </div>
        </label>
      </div>

      <div class="actions u-mt-8px">
        <button type="button" class="primary lc-btn u-p-10px_24px u-fs-v_font_size_base u-fw-600" id="btnUnifiedImport" data-act="runUnifiedListImport">Start Import</button>
      </div>

      <div id="unifiedImportResult" class="u-mt-12px"></div>
    </div>
  </div>

  <!-- Submenu 3: Feedback & Support -->
  <div class="settings-subpanel" id="settingsSubFeedback" style="display:none;">
    <div class="panel">
      <div class="u-jc-space_between u-ai-center u-fw2-wrap u-gap-8px u-mb-12px" style="display:flex;">
        <div>
          <h2 class="panel-title u-m-0">Support &amp; Developer Chat</h2>
          <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_sm">Have a question, found a bug, or have a suggestion? Chat directly with the developer.</p>
        </div>
        <button type="button" class="secondary lc-btn u-p-6px_14px u-fs-v_font_size_sm" id="btnNewFeedbackTicket" data-act="toggleNewFeedbackForm" data-act-args="[true]">+ New Message</button>
      </div>

      <!-- Active Threads Selector -->
      <div id="supportThreadsBar" class="support-threads-bar u-mb-12px" style="display:none;"></div>

      <div class="feedback-container">
        <!-- Chat View -->
        <div id="supportChatView" style="display:none;">
          <div id="supportMessagesStream" class="support-messages-stream"></div>
          <div class="support-reply-composer u-mt-10px">
            <textarea id="supportReplyInput" placeholder="Type a reply to the developer..." data-act-on="keydown" data-act="appActFeedbackReplyOnEnter" data-act-args="[&quot;@event&quot;]"></textarea>
            <button type="button" class="primary lc-btn u-minh-44px u-p-0_20px" id="supportReplySendBtn" data-act="sendUserFeedbackReply">Send</button>
          </div>
          <div class="u-jc-space_between u-ai-center u-mt-6px" style="display:flex;">
            <span id="supportChatStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
            <button type="button" class="secondary lc-btn u-p-2px_8px u-fs-v_font_size_xs u-bd-none u-bg-none u-c-v_muted u-cur-pointer" data-act="refreshUserFeedbackThreads">&#x21BB; Refresh</button>
          </div>
        </div>

        <!-- New Message / Initial Form -->
        <div id="newFeedbackFormWrap">
          <div class="row">
            <label class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">Category</label>
            <select id="feedbackCategorySelect" aria-label="Feedback category" class="u-maxw-320px u-br-v_radius_pill u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-p-7px_12px u-fs-v_font_size_sm">
              <option value="bug">Bug Report</option>
              <option value="improvement">Improvement / Feature Request</option>
              <option value="idea">Idea / Suggestion</option>
              <option value="other">General Question / Other</option>
            </select>
          </div>
          <div class="row u-mt-10px">
            <label class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">Message</label>
            <textarea id="feedbackMessageInput" rows="4" class="u-maxw-680px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-p-10px_12px u-fs-v_font_size_sm u-bs-border_box" style="width:100%;" placeholder="What would you like help with or what did you find?"></textarea>
          </div>
          <div class="row u-mt-10px">
            <label class="u-fs-v_font_size_sm u-fw-600 u-c-v_text u-mb-4px" style="display:block;">Contact Info (optional)</label>
            <input type="text" id="feedbackContactInput" placeholder="Email, Discord username, etc. (optional)" class="u-maxw-440px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-p-8px_12px u-fs-v_font_size_sm u-bs-border_box" style="width:100%;">
          </div>
          <div class="actions u-mt-12px u-gap-8px u-jc-flex_start">
            <button type="button" class="primary lc-btn u-p-8px_20px u-fs-v_font_size_sm u-fw-600" id="feedbackSubmitBtn" data-act="submitFeedback">Send Message</button>
            <button type="button" class="secondary lc-btn" id="feedbackCancelNewBtn" style="display:none;" data-act="toggleNewFeedbackForm" data-act-args="[false]">Cancel</button>
          </div>
          <p id="feedbackStatus" class="u-mt-8px u-fs-v_font_size_sm"></p>
        </div>
      </div>
    </div>

    <!-- Resources & Documentation Section -->
    <div class="panel u-mt-14px">
      <h2 class="panel-title">Resources &amp; Support</h2>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Helpful guides, documentation, and ways to support continued hosting and development of My Lists Addon.</p>
      
      <div class="resource-cards-grid">
        <a href="/guide" class="resource-card">
          <div>
            <div class="resource-card-title">User Guide &amp; Docs</div>
            <div class="resource-card-desc">Step-by-step how-to guides covering catalogs, channels, storylines, and list importing.</div>
          </div>
          <span class="secondary lc-btn u-as-flex_start u-p-6px_14px u-fs-v_font_size_sm" style="pointer-events:none;">Open Guide &rarr;</span>
        </a>

        <a href="https://ko-fi.com/mylistsaddon" target="_blank" rel="noopener" class="resource-card">
          <div>
            <div class="resource-card-title">Support on Ko-fi</div>
            <div class="resource-card-desc">Support the continued development and hosting costs of the free public server.</div>
          </div>
          <span class="secondary lc-btn u-as-flex_start u-p-6px_14px u-fs-v_font_size_sm" style="pointer-events:none;">Support Project &rarr;</span>
        </a>

        <a href="https://torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1" target="_blank" rel="noopener" class="resource-card">
          <div>
            <div class="resource-card-title">TorBox Debrid</div>
            <div class="resource-card-desc">Fast, modern debrid provider with fast torrent caching and Usenet support.</div>
          </div>
          <span class="secondary lc-btn u-as-flex_start u-p-6px_14px u-fs-v_font_size_sm" style="pointer-events:none;">Try TorBox (Referral) &rarr;</span>
        </a>
      </div>
    </div>
  </div>
</div>
</div>


